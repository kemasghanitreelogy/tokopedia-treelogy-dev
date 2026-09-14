-- Skema Supabase untuk pesanan omnichannel Treelogy.
--
-- File ini adalah keadaan akhir, bukan riwayat: menjalankannya di proyek kosong
-- menghasilkan database yang sama persis dengan yang dipakai produksi. Ia ada di repo
-- karena migrasi yang hanya hidup di dashboard Supabase adalah pengetahuan yang tidak
-- bisa ditinjau, tidak bisa ditiru ke proyek kedua, dan hilang bersama proyeknya.
--
--   psql "$SUPABASE_DB_URL" -f db/schema.sql
--
-- Aman dijalankan ulang di proyek yang sudah berisi: semua objek memakai if not exists
-- atau create or replace, dan tidak ada satu pun perintah yang menghapus data.

-- ---------------------------------------------------------------------------
-- Pesanan
-- ---------------------------------------------------------------------------

-- payload menyimpan pesanan hasil normalisasi apa adanya, sehingga sebuah baris dapat
-- dikembalikan menjadi persis bentuk yang dihasilkan collectOrders(). Kolom di sebelahnya
-- adalah proyeksi dari payload itu - ada supaya bisa di-index dan difilter, bukan sebagai
-- sumber kebenaran kedua.
create table if not exists public.orders (
  channel       text        not null,
  id            text        not null,
  created_at    timestamptz not null,
  stage         text        not null,
  status        text        not null default '',
  total         bigint      not null default 0,
  buyer         text        not null default '',
  buyer_email   text        not null default '',
  tracking      text        not null default '',
  carrier       text        not null default '',
  items         integer     not null default 0,
  payload       jsonb       not null,
  -- Kapan pesanan ini dibaca dari platform, bukan kapan barisnya ditulis. Inilah yang
  -- menentukan siapa yang menang saat webhook dan sapuan menulis pesanan yang sama.
  fetched_at    timestamptz not null,
  source        text        not null default 'unknown',
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (channel, id)
);

-- Dashboard selalu bertanya "pesanan dalam rentang tanggal ini", lalu memotongnya per
-- kanal atau per tahap. Tiga index ini yang melayani semuanya.
create index if not exists orders_created_at_idx            on public.orders (created_at desc);
create index if not exists orders_channel_created_at_idx    on public.orders (channel, created_at desc);
create index if not exists orders_stage_created_at_idx      on public.orders (stage, created_at desc);

-- Baris produk, didatarkan keluar dari payload.
--
-- Ada terpisah karena pertanyaan yang paling mahal di sistem ini bersifat per-SKU
-- ("berapa OMC-90-001 terjual sejak 1 Agustus"), dan menjawabnya dengan menjelajahi JSONB
-- setiap pesanan berarti membaca seluruh tabel untuk satu angka.
create table if not exists public.order_lines (
  channel       text    not null,
  order_id      text    not null,
  line_no       integer not null,
  -- SKU master hasil resolusi; null berarti data master belum mengenalnya, dan itu
  -- sengaja dibiarkan terlihat daripada ditebak.
  sku           text,
  raw_sku       text    not null default '',
  name          text    not null default '',
  qty           integer not null,
  unit_price    bigint  not null default 0,
  unit_discount bigint  not null default 0,
  -- Disalin dari pesanan induk supaya pertanyaan per-SKU cukup membaca satu tabel.
  created_at    timestamptz not null,
  stage         text    not null,
  primary key (channel, order_id, line_no),
  foreign key (channel, order_id) references public.orders (channel, id) on delete cascade
);

create index if not exists order_lines_sku_created_at_idx on public.order_lines (sku, created_at desc);
create index if not exists order_lines_created_at_idx     on public.order_lines (created_at desc);

-- Sampai kapan setiap sumber tarikan benar-benar sudah terbaca.
--
-- Tanpa ini, rentang yang belum pernah ditarik terlihat persis sama dengan rentang yang
-- memang tidak ada penjualannya: dua-duanya nol baris. Dashboard membaca tabel ini untuk
-- tahu kapan ia boleh menjawab dari database dan kapan ia harus membaca platform.
--
-- Kuncinya sumber, bukan kanal: satu API TikTok Shop melayani pesanan Tokopedia dan
-- TikTok Shop sekaligus, jadi minggu yang kebetulan tidak ada pesanan Tokopedia-nya tidak
-- akan pernah tercatat sebagai sudah terbaca kalau dikunci per kanal.
create table if not exists public.ingest_coverage (
  source          text primary key,
  covered_from    timestamptz not null,
  covered_through timestamptz not null,
  last_run_at     timestamptz not null default now(),
  note            text not null default ''
);

-- ---------------------------------------------------------------------------
-- Penyerapan
-- ---------------------------------------------------------------------------

-- Menyerap sekumpulan pesanan dalam satu perjalanan, dengan aturan "bacaan terbaru menang".
--
-- Dua penulis mengejar pesanan yang sama sepanjang waktu: webhook menulisnya beberapa
-- detik setelah pembeli membayar, dan sapuan 15 menit membacanya lagi sebagai jaring
-- pengaman. Kalau yang menang adalah yang menulis belakangan, sapuan yang membaca
-- snapshot lama bisa memundurkan pesanan dari "shipping" kembali ke "to_ship". Yang
-- dibandingkan karena itu bukan waktu tulis, melainkan fetched_at: kapan data itu dibaca
-- dari platformnya.
--
-- Baris produk diganti utuh, tidak ditambal. Sebuah pesanan bisa kehilangan baris saat
-- pembeli membatalkan sebagian, dan menambal akan meninggalkan baris hantu yang tetap
-- ikut terhitung sebagai permintaan.
--
-- Semua angka uang dibulatkan lewat numeric. Cast ::bigint langsung menolak "1073252.09",
-- dan satu pesanan Shopify seperti itu pernah menggagalkan seluruh batch yang memuatnya.
create or replace function public.ingest_orders(p_orders jsonb, p_source text default 'unknown')
returns integer
language plpgsql
as $$
declare
  v_written integer;
begin
  if p_orders is null or jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) = 0 then
    return 0;
  end if;

  create temporary table _incoming on commit drop as
  select
    o->>'channel'                                                      as channel,
    o->>'id'                                                           as id,
    to_timestamp((o->>'createdAt')::double precision)                  as created_at,
    coalesce(o->>'stage', '')                                          as stage,
    coalesce(o->>'status', '')                                         as status,
    coalesce(round(nullif(o->>'total', '')::numeric), 0)::bigint       as total,
    coalesce(o->>'buyer', '')                                          as buyer,
    coalesce(o->>'buyerEmail', '')                                     as buyer_email,
    coalesce(o->>'tracking', '')                                       as tracking,
    coalesce(o->>'carrier', '')                                        as carrier,
    coalesce(round(nullif(o->>'items', '')::numeric), 0)::integer      as items,
    o                                                                  as payload,
    coalesce(to_timestamp((o->>'fetchedAt')::double precision), now()) as fetched_at
  from jsonb_array_elements(p_orders) as o
  where o->>'channel' is not null and o->>'id' is not null;

  create temporary table _written on commit drop as
  with up as (
    insert into public.orders as t (
      channel, id, created_at, stage, status, total, buyer, buyer_email,
      tracking, carrier, items, payload, fetched_at, source
    )
    select
      channel, id, created_at, stage, status, total, buyer, buyer_email,
      tracking, carrier, items, payload, fetched_at, p_source
    from _incoming
    on conflict (channel, id) do update set
      created_at  = excluded.created_at,
      stage       = excluded.stage,
      status      = excluded.status,
      total       = excluded.total,
      buyer       = excluded.buyer,
      buyer_email = excluded.buyer_email,
      tracking    = excluded.tracking,
      carrier     = excluded.carrier,
      items       = excluded.items,
      payload     = excluded.payload,
      fetched_at  = excluded.fetched_at,
      source      = excluded.source,
      updated_at  = now()
    -- Bacaan yang lebih tua dari yang sudah tersimpan diabaikan, bukan ditulis.
    where excluded.fetched_at >= t.fetched_at
    returning t.channel, t.id
  )
  select channel, id from up;

  select count(*) into v_written from _written;

  delete from public.order_lines l
  using _written w
  where l.channel = w.channel and l.order_id = w.id;

  insert into public.order_lines (
    channel, order_id, line_no, sku, raw_sku, name, qty, unit_price, unit_discount, created_at, stage
  )
  select
    i.channel,
    i.id,
    (line.ord - 1)::integer,
    nullif(coalesce(line.value->>'masterSku', ''), ''),
    coalesce(line.value->>'sku', ''),
    coalesce(line.value->>'name', ''),
    coalesce(round(nullif(line.value->>'qty', '')::numeric), 0)::integer,
    coalesce(round(nullif(line.value->>'unitPrice', '')::numeric), 0)::bigint,
    coalesce(round(nullif(line.value->>'unitDiscount', '')::numeric), 0)::bigint,
    i.created_at,
    i.stage
  from _incoming i
  join _written w on w.channel = i.channel and w.id = i.id
  cross join lateral jsonb_array_elements(
    coalesce(i.payload->'finance'->'lines', '[]'::jsonb)
  ) with ordinality as line(value, ord)
  where coalesce(round(nullif(line.value->>'qty', '')::numeric), 0) > 0;

  drop table _incoming;
  drop table _written;
  return v_written;
end;
$$;

-- ---------------------------------------------------------------------------
-- Hak akses
-- ---------------------------------------------------------------------------

-- Data pesanan berisi nama, email, dan alamat pembeli. Kunci published/anon tidak boleh
-- melihat apa pun di sini: RLS menyala tanpa satu pun policy, jadi yang tersisa hanya
-- kunci rahasia di server yang memang melewati RLS.
alter table public.orders          enable row level security;
alter table public.order_lines     enable row level security;
alter table public.ingest_coverage enable row level security;

revoke all on public.orders          from anon, authenticated;
revoke all on public.order_lines     from anon, authenticated;
revoke all on public.ingest_coverage from anon, authenticated;

-- Postgres memberikan EXECUTE atas setiap fungsi baru kepada PUBLIC, jadi mencabutnya
-- dari anon saja tidak menutup apa pun - anon mewarisi lewat PUBLIC. Diuji langsung
-- terhadap proyek ini: sebelum baris di bawah dipasang, kunci publishable (yang memang
-- dirancang untuk boleh terlihat siapa saja) berhasil memanggil ingest_orders dan
-- mendapat balasan 200, artinya siapa pun yang memegangnya bisa menulis baris sekehendak
-- hati ke tabel pesanan.
revoke all on function public.ingest_orders(jsonb, text) from public;
revoke all on function public.ingest_orders(jsonb, text) from anon, authenticated;

-- Supaya fungsi berikutnya tidak lahir dengan pintu terbuka lagi.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
