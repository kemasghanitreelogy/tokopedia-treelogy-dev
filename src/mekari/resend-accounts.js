/**
 * The two accounts a resend's journal entry names.
 *
 * In their own file because accounts.js checks them at setup and resend.js writes them,
 * and resend.js imports accounts.js - putting the constants in either one would be a
 * circle. They are numbers here and names on the wire; accountMap is what turns one into
 * the other, and both exist in the live chart:
 *
 *   6-60216  Waste Goods Expense   what the mistake cost
 *   1-10200  Inventory             the goods that left and are not coming back
 */
export const WASTE_ACCOUNT = '6-60216';
export const INVENTORY_ACCOUNT = '1-10200';
