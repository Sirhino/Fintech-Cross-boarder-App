// GET /api/withdrawal/countries — static list, no auth needed (it's just config)
import { SUPPORTED_COUNTRIES } from './_blockradar.js';
import { jsonResponse, optionsResponse } from '../_auth.js';

export async function onRequestGet() {
  return jsonResponse({ countries: SUPPORTED_COUNTRIES });
}
export async function onRequestOptions() { return optionsResponse(); }
