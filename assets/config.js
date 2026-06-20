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
  aiEnabled: false,
  aiProxyUrl: "",
  maxQuestionLength: 500
});
