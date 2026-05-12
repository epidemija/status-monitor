// CMS and technology-stack fingerprinter.
// Makes 2-4 lightweight HTTP requests per site (main page + a couple of
// probe paths) and analyses HTML, headers, and URL responses.
// No external API needed — everything is done locally.

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

function makeClient(baseUrl) {
  return axios.create({
    baseURL: baseUrl,
    timeout: TIMEOUT,
    validateStatus: () => true, // accept any status, we probe 404s intentionally
    maxRedirects: 5,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

async function get(client, path) {
  try {
    const r = await client.get(path);
    return {
      ok: r.status < 400,
      status: r.status,
      html: typeof r.data === 'string' ? r.data.slice(0, 300000) : '',
      headers: r.headers || {},
    };
  } catch (_) {
    return null;
  }
}

// ─── HTML extractors ────────────────────────────────────────────────────────

function metaGenerator(html) {
  const m = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
  return m ? m[1].trim() : null;
}

function extractWpTheme(html) {
  // Prefer active stylesheet path over any asset reference
  const css = html.match(/href=["'][^"']*\/wp-content\/themes\/([^\/'"?]+)/i);
  if (css) return css[1];
  const any = html.match(/\/wp-content\/themes\/([^\/'"?]+)/i);
  return any ? any[1] : null;
}

function extractWpVersion(html, generator) {
  if (generator) {
    const m = generator.match(/WordPress[\s\/]+([\d.]+)/i);
    if (m) return m[1];
  }
  // ver= param on wp-includes assets is usually the WP core version
  const m = html.match(/\/wp-includes\/[^"'?]+\?ver=([\d.]+)/i);
  return m ? m[1] : null;
}

function extractWpPlugins(html) {
  const seen = new Set();
  const re = /\/wp-content\/plugins\/([^\/'"?\s\\]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1].toLowerCase();
    if (slug && slug.length > 1) seen.add(slug);
  }
  return [...seen].sort();
}

// ─── Header analysers ────────────────────────────────────────────────────────

function detectCdn(headers, html) {
  const h = (k) => (headers[k] || '').toLowerCase();
  if (headers['cf-ray'] || headers['cf-cache-status'])                   return 'Cloudflare';
  if (headers['x-amz-cf-id'] || headers['x-amz-cf-pop'])                return 'Amazon CloudFront';
  if (h('x-served-by').includes('cache-'))                               return 'Fastly';
  if (headers['x-azure-ref'] || h('server').includes('azure'))           return 'Azure CDN';
  if (h('x-cache').includes('varnish') || h('via').includes('varnish'))  return 'Varnish';
  if (headers['x-sucuri-id'] || h('server').includes('sucuri'))          return 'Sucuri';
  if (h('server').includes('bunnycdn'))                                   return 'BunnyCDN';
  if (headers['fly-request-id'])                                          return 'Fly.io';
  if (headers['x-vercel-id'])                                             return 'Vercel';
  if (headers['x-netlify-originmod'] || h('server').includes('netlify')) return 'Netlify';
  if (/cdn\.jsdelivr\.net|unpkg\.com/.test(html))                        return 'jsDelivr/unpkg (assets)';
  return null;
}

function detectLanguage(headers, html) {
  const p = (headers['x-powered-by'] || '').toLowerCase();
  if (p.includes('php'))           return 'PHP';
  if (p.includes('asp.net'))       return 'ASP.NET';
  if (p.includes('express'))       return 'Node.js (Express)';
  if (p.includes('ruby'))          return 'Ruby';
  if (p.includes('python'))        return 'Python';
  if (p.includes('java'))          return 'Java';
  // HTML-based heuristics
  if (/__NEXT_DATA__/.test(html))  return 'Node.js (Next.js)';
  if (/gatsby-/.test(html))        return 'Node.js (Gatsby)';
  if (/"nuxt"/.test(html) || /__NUXT__/.test(html)) return 'Node.js (Nuxt.js)';
  if (/laravel/i.test(html))       return 'PHP (Laravel)';
  if (/symfony/i.test(html))       return 'PHP (Symfony)';
  if (/django/i.test(html))        return 'Python (Django)';
  if (/rails/i.test(html))         return 'Ruby on Rails';
  return null;
}

function detectTech(html, headers) {
  const found = [];
  if (/google-analytics\.com\/analytics|gtag\(["']G-/i.test(html)) found.push('Google Analytics 4');
  else if (/google-analytics\.com/i.test(html))                     found.push('Google Analytics');
  if (/googletagmanager\.com/i.test(html))                          found.push('Google Tag Manager');
  if (/jquery[\.-][\d]/i.test(html))                                found.push('jQuery');
  if (/bootstrap[\.-][\d]/i.test(html) || /class=["']col-[a-z]+-\d+/.test(html)) found.push('Bootstrap');
  if (/react[\.-][\d]/i.test(html) || /_reactRoot/.test(html) || /data-reactroot/.test(html)) found.push('React');
  if (/vue[\.-][\d]/i.test(html) || /v-bind:|v-on:|v-if=/.test(html)) found.push('Vue.js');
  if (/angular(?:js)?[\.-][\d]/i.test(html))                        found.push('Angular');
  if (/woocommerce/i.test(html))                                     found.push('WooCommerce');
  if (/elementor/i.test(html))                                       found.push('Elementor');
  if (/yoast-seo|rank-math/i.test(html))                            found.push('SEO Plugin');
  if (/wp-rocket/i.test(html))                                       found.push('WP Rocket');
  if (/wordfence/i.test(html))                                       found.push('Wordfence');
  if (/cookie-law-info|cookiebot|tarteaucitron/i.test(html))        found.push('Cookie Consent');
  if (/matomo|piwik/i.test(html))                                    found.push('Matomo Analytics');
  if (/hotjar/i.test(html))                                          found.push('Hotjar');
  if (/recaptcha/i.test(html))                                       found.push('Google reCAPTCHA');
  if (/cloudflare\.com\/ajax\/libs/i.test(html))                    found.push('Cloudflare CDNJS');
  if (/fonts\.googleapis\.com/i.test(html))                         found.push('Google Fonts');
  return [...new Set(found)];
}

// Well-known plugin slug → display name
const PLUGIN_NAMES = {
  'woocommerce': 'WooCommerce',
  'contact-form-7': 'Contact Form 7',
  'elementor': 'Elementor',
  'elementor-pro': 'Elementor Pro',
  'yoast-seo': 'Yoast SEO',
  'all-in-one-seo-pack': 'All in One SEO',
  'rank-math': 'Rank Math SEO',
  'akismet': 'Akismet',
  'jetpack': 'Jetpack',
  'wordfence': 'Wordfence Security',
  'really-simple-ssl': 'Really Simple SSL',
  'wp-rocket': 'WP Rocket',
  'litespeed-cache': 'LiteSpeed Cache',
  'w3-total-cache': 'W3 Total Cache',
  'wp-super-cache': 'WP Super Cache',
  'autoptimize': 'Autoptimize',
  'revslider': 'Slider Revolution',
  'js_composer': 'WPBakery Page Builder',
  'wpforms-lite': 'WPForms',
  'wpforms': 'WPForms Pro',
  'gravity-forms': 'Gravity Forms',
  'mailchimp-for-wp': 'Mailchimp for WP',
  'wpcf7': 'Contact Form 7',
  'polylang': 'Polylang',
  'wpml': 'WPML',
  'cookie-law-info': 'Cookie Law Info',
  'cookiebot': 'Cookiebot',
  'gtm4wp': 'GTM for WordPress',
  'google-analytics-for-wordpress': 'MonsterInsights',
  'siteground-optimizer': 'SiteGround Optimizer',
  'query-monitor': 'Query Monitor',
  'advanced-custom-fields': 'Advanced Custom Fields',
  'acf': 'Advanced Custom Fields',
  'the-events-calendar': 'The Events Calendar',
  'woo-subscriptions': 'WooCommerce Subscriptions',
};

function labelPlugins(slugs) {
  return slugs.map((s) => ({ slug: s, name: PLUGIN_NAMES[s] || s }));
}

// ─── Main scanner ────────────────────────────────────────────────────────────

async function scanSite(site) {
  const result = {
    site_id: site.id,
    cms: null,
    cms_version: null,
    theme: null,
    theme_version: null,
    plugins: [],
    server: null,
    powered_by: null,
    generator: null,
    cdn: null,
    language: null,
    technologies: [],
    error: null,
  };

  let baseUrl;
  try {
    const u = new URL(site.url);
    baseUrl = `${u.protocol}//${u.host}`;
  } catch (_) {
    result.error = 'Invalid URL';
    return result;
  }

  const client = makeClient(baseUrl);

  const main = await get(client, '/');
  if (!main) {
    result.error = 'Could not reach site';
    return result;
  }

  const { html, headers } = main;
  result.server     = headers['server'] || null;
  result.powered_by = headers['x-powered-by'] || null;
  result.generator  = metaGenerator(html);
  result.cdn        = detectCdn(headers, html);
  result.language   = detectLanguage(headers, html);
  result.technologies = detectTech(html, headers);

  // ── WordPress ────────────────────────────────────────────────────────────
  const isWp = /\/wp-content\//i.test(html)
    || /\/wp-includes\//i.test(html)
    || (result.generator && /WordPress/i.test(result.generator))
    || (headers['link'] || '').includes('wp-json');

  if (isWp) {
    result.cms        = 'WordPress';
    result.cms_version = extractWpVersion(html, result.generator);
    const themeSlug   = extractWpTheme(html);
    result.plugins    = labelPlugins(extractWpPlugins(html));

    // Try to resolve theme display name + version from style.css
    if (themeSlug) {
      const styleRes = await get(client, `/wp-content/themes/${themeSlug}/style.css`);
      if (styleRes && styleRes.status === 200 && styleRes.html) {
        const tn = styleRes.html.match(/^Theme Name:\s*(.+)$/im);
        const tv = styleRes.html.match(/^Version:\s*([\d.]+)/im);
        result.theme        = tn ? tn[1].trim() : themeSlug;
        result.theme_version = tv ? tv[1].trim() : null;
      } else {
        result.theme = themeSlug;
      }
    }

    // Try /readme.html for WP version if not found yet
    if (!result.cms_version) {
      const rdm = await get(client, '/readme.html');
      if (rdm && rdm.status === 200) {
        const m = rdm.html.match(/Version\s+([\d.]+)/i);
        if (m) result.cms_version = m[1];
      }
    }
    return result;
  }

  // ── Joomla ───────────────────────────────────────────────────────────────
  if ((result.generator && /Joomla/i.test(result.generator))
    || /\/components\/com_/i.test(html)
    || /\/media\/jui\//i.test(html)
    || /Joomla\.JText/i.test(html)) {
    result.cms = 'Joomla';
    const gen = result.generator || '';
    const v = gen.match(/Joomla!?\s*([\d.]+)/i);
    if (v) result.cms_version = v[1];
    return result;
  }

  // ── Drupal ───────────────────────────────────────────────────────────────
  if ((result.generator && /Drupal/i.test(result.generator))
    || /\/sites\/default\//i.test(html)
    || /Drupal\.settings/i.test(html)
    || (headers['x-generator'] || '').includes('Drupal')) {
    result.cms = 'Drupal';
    const xg = headers['x-generator'] || result.generator || '';
    const v = xg.match(/Drupal\s+([\d.]+)/i);
    if (v) result.cms_version = v[1];
    return result;
  }

  // ── Shopify ──────────────────────────────────────────────────────────────
  if (/cdn\.shopify\.com/i.test(html) || headers['x-shopid'] || headers['x-shopify-stage']) {
    result.cms = 'Shopify';
    return result;
  }

  // ── TYPO3 ────────────────────────────────────────────────────────────────
  if ((result.generator && /TYPO3/i.test(result.generator))
    || /\/typo3conf\//i.test(html)
    || /\/typo3temp\//i.test(html)) {
    result.cms = 'TYPO3';
    const gen = result.generator || '';
    const v = gen.match(/TYPO3 CMS\s*([\d.]+)/i);
    if (v) result.cms_version = v[1];
    return result;
  }

  // ── Magento ──────────────────────────────────────────────────────────────
  if (/skin\/frontend\//i.test(html)
    || /\/mage\/cookies/i.test(html)
    || /Mage\.Cookies/i.test(html)
    || /\/pub\/static\/frontend\//i.test(html)) {
    result.cms = 'Magento';
    return result;
  }

  // ── PrestaShop ───────────────────────────────────────────────────────────
  if (/prestashop/i.test(html)
    || /\/modules\/blockcart\//i.test(html)
    || (result.generator && /PrestaShop/i.test(result.generator))) {
    result.cms = 'PrestaShop';
    const gen = result.generator || '';
    const v = gen.match(/PrestaShop\s*([\d.]+)/i);
    if (v) result.cms_version = v[1];
    return result;
  }

  // ── Wix ──────────────────────────────────────────────────────────────────
  if (/wix-warmup-data|wixsite\.com|\/wix-bolt\//i.test(html)
    || headers['x-wix-meta-site-id']) {
    result.cms = 'Wix';
    return result;
  }

  // ── Squarespace ──────────────────────────────────────────────────────────
  if (/static\.squarespace\.com|squarespace-cdn\.com/i.test(html)
    || (result.generator && /Squarespace/i.test(result.generator))) {
    result.cms = 'Squarespace';
    return result;
  }

  // ── Webflow ──────────────────────────────────────────────────────────────
  if (/webflow\.com\/css|assets\.website-files\.com/i.test(html)
    || (result.generator && /Webflow/i.test(result.generator))) {
    result.cms = 'Webflow';
    return result;
  }

  // ── Ghost ────────────────────────────────────────────────────────────────
  if (/ghost\/themes|ghost\.io/i.test(html)
    || (result.generator && /Ghost/i.test(result.generator))) {
    result.cms = 'Ghost';
    const gen = result.generator || '';
    const v = gen.match(/Ghost\s*([\d.]+)/i);
    if (v) result.cms_version = v[1];
    return result;
  }

  // ── HubSpot ──────────────────────────────────────────────────────────────
  if (/hubspot\.com\/hs\//i.test(html) || headers['x-hs-cf-stack']) {
    result.cms = 'HubSpot CMS';
    return result;
  }

  // ── OpenCart ─────────────────────────────────────────────────────────────
  if (/route=common\/home/i.test(html) || /opencart/i.test(headers['x-powered-by'] || '')) {
    result.cms = 'OpenCart';
    return result;
  }

  return result; // no CMS identified
}

// Scan a site and return a DB-ready row.
async function scanAndFormat(site) {
  try {
    const r = await scanSite(site);
    return {
      site_id:       r.site_id,
      cms:           r.cms,
      cms_version:   r.cms_version,
      theme:         r.theme,
      theme_version: r.theme_version,
      plugins:       JSON.stringify(r.plugins),
      technologies:  JSON.stringify(r.technologies),
      server:        r.server,
      powered_by:    r.powered_by,
      generator:     r.generator,
      cdn:           r.cdn,
      language:      r.language,
      scan_status:   r.error ? 'error' : 'ok',
      error_message: r.error,
    };
  } catch (err) {
    return {
      site_id: site.id,
      cms: null, cms_version: null, theme: null, theme_version: null,
      plugins: '[]', technologies: '[]',
      server: null, powered_by: null, generator: null, cdn: null, language: null,
      scan_status: 'error',
      error_message: err.message || 'Unknown error',
    };
  }
}

module.exports = { scanSite, scanAndFormat };
