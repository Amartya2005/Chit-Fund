/**
 * Version of the finance engine's calculation behaviour. Bump on ANY change that can alter an
 * output for the same inputs + policy; it is stored with every calculation record so historical
 * results remain reproducible (FINANCIAL_ENGINE §1, INV-G2).
 */
export const FINANCE_ENGINE_VERSION = '1.0.0';
