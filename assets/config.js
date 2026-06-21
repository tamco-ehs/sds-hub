/*
 * Public runtime configuration. Never place credentials in this file.
 * When enabling AI, update index.html's Content-Security-Policy connect-src
 * directive with the exact HTTPS origin of the approved proxy.
 */
window.SDS_CONFIG = Object.freeze({
  siteName: "Digital SDS Hub",
  facilityName: "Facility safety library",
  emergencyLabel: "",
  emergencyHref: "",
  aiEnabled: true,
  aiProxyUrl: "https://jxvsxwsmfycvewxeyxmp.supabase.co/functions/v1/sds-api/v1/ask",
  supabaseUrl: "https://jxvsxwsmfycvewxeyxmp.supabase.co",
  supabaseAnonKey: "sb_publishable_mUJBlRLOSWNcHwFYnKCcbw_wqlUUx1u",
  adminApiUrl: "https://jxvsxwsmfycvewxeyxmp.supabase.co/functions/v1/sds-api",
  catalogApiUrl: "https://jxvsxwsmfycvewxeyxmp.supabase.co/functions/v1/sds-api/v1/catalog",
  maxQuestionLength: 500
});
