// Tracker hosts (slice 3i, #40): two short lists written for Mail.
//
// Source and criteria: the open-tracking and click-tracking hosts of large,
// widely used email service providers and sales-email tools, as they appear
// in their own published tracking URLs (SendGrid `ct.sendgrid.net`, Mailchimp
// `list-manage.com`, Mandrill, Salesforce Marketing Cloud `exct.net`,
// Constant Contact `rs6.net`, Amazon SES `awstrack.me`, Mailjet `mjt.lu`,
// HubSpot `hubspotlinks.com`, Campaign Monitor `createsend1.com`) and of the
// read-receipt tools Superhuman, Streak (`mailstat.us`), Yesware and
// Mailtrack. A host is listed only when everything the mail loads or links
// from it is tracking; customer-branded tracking domains cannot be listed.
// Reviewed by hand, not measured against real mail, never updated over the
// network. An entry is an exact host, or `.suffix` for any host below it.

/** Hosts whose images in mail are open-tracking pixels; dropped even when images are allowed. */
export const TRACKER_HOSTS: readonly string[] = [
  ".ct.sendgrid.net",
  ".list-manage.com",
  "mandrillapp.com",
  ".exct.net",
  ".rs6.net",
  ".awstrack.me",
  ".mjt.lu",
  "r.superhuman.com",
  "mailstat.us",
  "t.yesware.com",
  "mailtrack.io",
];

/**
 * ESP click-tracking redirect hosts: a link to one hides where it ends. Mail
 * never follows it to find out; the status line names the host and the
 * deceptive-link dialog is not shown for it (part A resolution 1).
 */
export const TRACKING_REDIRECT_HOSTS: readonly string[] = [
  ".ct.sendgrid.net",
  ".list-manage.com",
  "mandrillapp.com",
  ".exct.net",
  ".rs6.net",
  ".awstrack.me",
  ".mjt.lu",
  ".hubspotlinks.com",
  ".createsend1.com",
  "t.yesware.com",
];

function normalHost(host: string): string | null {
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]{1,253}$/.test(value) ? value : null;
}

function listed(host: string, list: readonly string[]): boolean {
  const value = normalHost(host);
  if (value === null) return false;
  return list.some((entry) => (entry.startsWith(".") ? value.endsWith(entry) && value.length > entry.length : value === entry));
}

/** Whether an image from this host is a listed open-tracking pixel. */
export function isTrackerHost(host: string): boolean {
  return listed(host, TRACKER_HOSTS);
}

/** Whether a link to this host is a listed click-tracking redirect. */
export function isTrackingRedirectHost(host: string): boolean {
  return listed(host, TRACKING_REDIRECT_HOSTS);
}
