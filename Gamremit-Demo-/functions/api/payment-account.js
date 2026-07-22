// functions/api/payment-account.js — Cloudflare Pages Function
import { jsonResponse, optionsResponse } from './_auth.js';

export async function onRequestGet({ env }) {
  return jsonResponse({
    success: true,
    account: {
      bankName:            'Trust Bank Gambia',
      accountName:         'GamRemit Ltd',
      accountNumber:       env.BANK_ACCOUNT_NUMBER || '1234567890',
      bankBranch:          'Serrekunda Branch',
      mobileMoneyProvider: 'Wave Mobile Money',
      mobileMoneyName:     'GamRemit Ltd',
      mobileMoneyNumber:   env.MOBILE_MONEY_NUMBER || '+220 XXX XXXX',
      usdcAddress:         env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
      network:             'Arc Testnet · Chain 5042002'
    }
  });
}

export async function onRequestOptions() { return optionsResponse(); }
