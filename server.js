'use strict';

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Basic setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 8080;

// Hard cap for each scan in milliseconds (30 seconds)
const DEFAULT_TIMEOUT_MS = 30_000;

// Desktop Chrome user agent so we look like a normal browser
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Safe headless flags for common hosting environments
const HEADLESS_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
];

const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize and validate user URL input.
 * - Adds https:// if missing.
 * - Ensures only http/https protocols.
 */
function normalizeUrl(rawUrl = '') {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error('Invalid URL. Provide a valid http(s) URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP/HTTPS protocols are allowed.');
  }

  return url;
}

/**
 * Build a standardized issue object.
 */
function buildIssue(category, severity, message) {
  return { category, severity, message };
}

/**
 * Run a function with a hard timeout.
 */
async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core scan logic
// ---------------------------------------------------------------------------

/**
 * Perform the elite scan for a single URL.
 * Returns the JSON object described in the requirements.
 */
async function performScan(inputUrl) {
  let browser;

  try {
    const targetUrl = normalizeUrl(inputUrl);

    console.log(`[EliteScanner] Starting scan for ${targetUrl.href}`);

    // 1) Setup browser and context
    browser = await chromium.launch({
      headless: true,
      args: HEADLESS_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
    });

    // 2) GDPR: track external fonts / maps via request interception
    const gdprFindings = {
      googleFonts: false,
      googleMaps: false,
    };

    await context.route('**/*', async (route) => {
      try {
        const reqUrl = route.request().url();

        // Google Fonts
        if (/fonts\.googleapis\.com/i.test(reqUrl) || /fonts\.gstatic\.com/i.test(reqUrl)) {
          gdprFindings.googleFonts = true;
        }

        // Google Maps
        if (/maps\.googleapis\.com/i.test(reqUrl) || /maps\.gstatic\.com/i.test(reqUrl)) {
          gdprFindings.googleMaps = true;
        }

        await route.continue();
      } catch (routeError) {
        console.warn('[EliteScanner] Route interception error:', routeError.message);
        try {
          await route.continue();
        } catch {
          // Never crash due to routing issues
        }
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    // 3) Navigate (HTTP vs HTTPS handled by final URL)
    try {
      await page.goto(targetUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
      });
      await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {
        // networkidle might never fire – that's OK
      });
    } catch {
      throw new Error('Target site unreachable or timed out.');
    }

    const finalUrl = page.url();
    const finalProtocol = (() => {
      try {
        return new URL(finalUrl).protocol;
      } catch {
        return 'http:';
      }
    })();

    // 4) Extract DOM-based info
    const pageData = await page.evaluate(() => {
      const html = document.documentElement?.innerHTML || '';
      const lowerHtml = html.toLowerCase();

      const anchors = Array.from(document.querySelectorAll('a'));
      const hasImpressumLink = anchors.some((a) =>
        (a.textContent || '').toLowerCase().includes('impressum')
      );

      const techStackSet = new Set();

      // tech (Generator / CMS / builder)
      if (lowerHtml.includes('wp-content')) techStackSet.add('WordPress');
      if (lowerHtml.includes('wixstatic.com') || lowerHtml.includes('wixsite.com'))
        techStackSet.add('Wix');
      if (lowerHtml.includes('jimstatic.com') || lowerHtml.includes('jimdo'))
        techStackSet.add('Jimdo');

      // Extra tech signals
      if (lowerHtml.includes('squarespace')) techStackSet.add('Squarespace');
      if (lowerHtml.includes('shopify')) techStackSet.add('Shopify');

      // Google Analytics / Tag Manager
      if (
        lowerHtml.includes('google-analytics.com') ||
        lowerHtml.includes('gtag(') ||
        lowerHtml.includes('gtm.js') ||
        lowerHtml.includes('googletagmanager.com')
      ) {
        techStackSet.add('Google Analytics');
      }

      const title = (document.title || '').trim();
      const metaDescription =
        document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
      const hasViewportMeta = Boolean(document.querySelector('meta[name="viewport"]'));
      const h1Count = document.querySelectorAll('h1').length;

      return {
        title,
        metaDescription,
        hasViewportMeta,
        hasImpressumLink,
        h1Count,
        techStack: Array.from(techStackSet),
      };
    });

    // 5) Scoring & issues
    let score = 100;
    const issues = [];

    const applyPenalty = (amount) => {
      score = Math.max(0, score - amount);
    };

    // security (SSL)
    if (finalProtocol !== 'https:') {
      issues.push(
        buildIssue('security', 'high', 'Webseite ist nicht verschlüsselt (kein HTTPS).')
      );
      applyPenalty(40);
    }

    // mobile (Viewport)
    if (!pageData.hasViewportMeta) {
      issues.push(
        buildIssue('mobile', 'high', 'Kein responsiver Viewport-Meta-Tag gefunden.')
      );
      applyPenalty(20);
    }

    // legal (Impressum)
    if (!pageData.hasImpressumLink) {
      issues.push(
        buildIssue('legal', 'critical', 'Kein Impressum-Link gefunden.')
      );
      applyPenalty(30);
    }

    // gdpr (Google Fonts)
    if (gdprFindings.googleFonts) {
      issues.push(
        buildIssue(
          'gdpr',
          'high',
          'Google Fonts werden extern geladen (mögliche DSGVO-Verletzung).'
        )
      );
      applyPenalty(20);
    }

    // gdpr (Google Maps) – informational for now
    if (gdprFindings.googleMaps) {
      issues.push(
        buildIssue('gdpr', 'medium', 'Google Maps wird extern eingebunden.')
      );
    }

    // seo (Title)
    if (!pageData.title || pageData.title.length < 10) {
      const lengthInfo = pageData.title ? ` (${pageData.title.length} Zeichen)` : '';
      issues.push(
        buildIssue('seo', 'medium', `Seitentitel fehlt oder ist zu kurz${lengthInfo}.`)
      );
      applyPenalty(5);
    }

    // seo (Description)
    if (!pageData.metaDescription) {
      issues.push(
        buildIssue('seo', 'medium', 'Meta-Description fehlt.')
      );
      applyPenalty(5);
    }

    // seo (Headings / H1 count)
    if (pageData.h1Count === 0 || pageData.h1Count > 1) {
      issues.push(
        buildIssue('seo', 'medium', `H1-Struktur fehlerhaft (gefunden: ${pageData.h1Count}).`)
      );
      applyPenalty(5);
    }

    // 6) Optional screenshot of top page (base64)
    let screenshotBase64 = null;
    try {
      const screenshotBuffer = await page.screenshot({
        fullPage: false,
        type: 'jpeg',
        quality: 60,
      });
      screenshotBase64 = screenshotBuffer.toString('base64');
    } catch (screenshotError) {
      console.warn('[EliteScanner] Screenshot failed:', screenshotError.message);
    }

    const techStack = Array.from(new Set(pageData.techStack || []));

    return {
      url: targetUrl.href,
      finalUrl,
      score,
      screenshot: screenshotBase64,
      issues,
      techStack,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[EliteScanner] Browser close error:', closeError);
      }
    }
  }
}

/**
 * Content harvester - extracts all content for website relaunch
 */
async function harvestContent(inputUrl) {
  let browser;

  try {
    const targetUrl = normalizeUrl(inputUrl);
    console.log(`[ContentHarvester] Starting harvest for ${targetUrl.href}`);

    browser = await chromium.launch({
      headless: true,
      args: HEADLESS_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    // Navigate to the page
    try {
      await page.goto(targetUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
      });
      await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {
        // networkidle might never fire – that's OK
      });
    } catch {
      throw new Error('Target site unreachable or timed out.');
    }

    // Extract all content in browser context
    const extractedData = await page.evaluate(() => {
      // Helper: Extract emails from text
      function extractEmails(text) {
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const matches = text.match(emailRegex) || [];
        return [...new Set(matches)]; // Remove duplicates
      }

      // Helper: Extract phone numbers (German and international formats)
      function extractPhones(text) {
        const phoneRegex = /(\+?\d{1,4}[\s-]?)?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/g;
        const matches = text.match(phoneRegex) || [];
        // Filter out obvious false positives (like years)
        return [...new Set(matches.filter(p => p.replace(/\D/g, '').length >= 8))];
      }

      // Meta information
      const title = (document.title || '').trim();
      const metaDescription =
        document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';

      // Get all text content for email/phone extraction
      const bodyText = document.body?.innerText || '';
      
      // Also check mailto links for emails
      const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
      const mailtoEmails = mailtoLinks.map(a => {
        const href = a.getAttribute('href') || '';
        return href.replace('mailto:', '').split('?')[0];
      }).filter(Boolean);

      // Also check tel links for phones
      const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]'));
      const telPhones = telLinks.map(a => {
        const href = a.getAttribute('href') || '';
        return href.replace('tel:', '').trim();
      }).filter(Boolean);

      // Combine extracted contact info
      const emails = [...new Set([...extractEmails(bodyText), ...mailtoEmails])];
      const phones = [...new Set([...extractPhones(bodyText), ...telPhones])];

      // Extract headings
      const h1Texts = Array.from(document.querySelectorAll('h1'))
        .map(h => h.innerText?.trim())
        .filter(Boolean);
      const h2Texts = Array.from(document.querySelectorAll('h2'))
        .map(h => h.innerText?.trim())
        .filter(Boolean);
      const h3Texts = Array.from(document.querySelectorAll('h3'))
        .map(h => h.innerText?.trim())
        .filter(Boolean);

      const headlines = [...h1Texts, ...h2Texts, ...h3Texts];

      // Extract images (filter small icons, get dimensions)
      const images = Array.from(document.querySelectorAll('img'))
        .map(img => {
          const src = img.src;
          const width = img.naturalWidth || img.width || 0;
          const height = img.naturalHeight || img.height || 0;
          const alt = img.alt || '';
          
          return { src, width, height, alt, area: width * height };
        })
        .filter(img => {
          // Filter out small icons (< 200px in either dimension)
          return img.width >= 200 && img.height >= 200;
        })
        .sort((a, b) => b.area - a.area) // Sort by area (largest first)
        .slice(0, 5) // Take top 5
        .map(img => img.src);

      // Extract social media links
      const links = Array.from(document.querySelectorAll('a'));
      const socials = [];
      
      links.forEach(a => {
        const href = a.href?.toLowerCase() || '';
        if (href.includes('facebook.com/') && !href.includes('/sharer')) {
          socials.push({ platform: 'Facebook', url: a.href });
        } else if (href.includes('instagram.com/')) {
          socials.push({ platform: 'Instagram', url: a.href });
        } else if (href.includes('linkedin.com/')) {
          socials.push({ platform: 'LinkedIn', url: a.href });
        } else if (href.includes('twitter.com/') || href.includes('x.com/')) {
          socials.push({ platform: 'Twitter', url: a.href });
        } else if (href.includes('youtube.com/') || href.includes('youtu.be/')) {
          socials.push({ platform: 'YouTube', url: a.href });
        } else if (href.includes('xing.com/')) {
          socials.push({ platform: 'XING', url: a.href });
        }
      });

      // Remove duplicate socials
      const uniqueSocials = [];
      const seenUrls = new Set();
      socials.forEach(social => {
        if (!seenUrls.has(social.url)) {
          seenUrls.add(social.url);
          uniqueSocials.push(social);
        }
      });

      // Get main body text (cleaned)
      let rawText = bodyText;
      
      // Try to remove header/footer/nav text for cleaner content
      try {
        const mainContent = 
          document.querySelector('main') ||
          document.querySelector('article') ||
          document.querySelector('[role="main"]') ||
          document.querySelector('.content') ||
          document.querySelector('#content') ||
          document.body;
        
        if (mainContent) {
          rawText = mainContent.innerText || bodyText;
        }
      } catch {
        // Fallback to body text
      }

      // Trim to first 2000 chars
      const trimmedText = rawText.substring(0, 2000);

      return {
        meta: {
          title,
          description: metaDescription,
        },
        contact: {
          emails,
          phones,
        },
        socials: uniqueSocials,
        headlines,
        images,
        rawText: trimmedText,
      };
    });

    console.log(`[ContentHarvester] Extracted: ${extractedData.headlines.length} headlines, ${extractedData.images.length} images, ${extractedData.contact.emails.length} emails`);

    return {
      status: 'success',
      ...extractedData,
    };

  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[ContentHarvester] Browser close error:', closeError);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sitesweep-scanner' });
});

app.post('/scan', async (req, res) => {
  try {
    const url = req.body && req.body.url;

    const result = await withTimeout(
      performScan(url),
      DEFAULT_TIMEOUT_MS,
      'Scan timeout after 30 seconds.'
    );

    res.json(result);
  } catch (error) {
    console.error('[EliteScanner] Scan failed:', error);

    const message = error && error.message ? error.message : 'Scan failed';
    const isUserError =
      message.includes('URL is required') ||
      message.includes('Invalid URL') ||
      message.includes('Only HTTP/HTTPS protocols are allowed.');

    const status = isUserError
      ? 400
      : message.includes('unreachable') || message.includes('timeout')
      ? 502
      : 500;

    res.status(status).json({ error: message });
  }
});

app.post('/harvest', async (req, res) => {
  try {
    const url = req.body && req.body.url;

    const result = await withTimeout(
      harvestContent(url),
      DEFAULT_TIMEOUT_MS,
      'Harvest timeout after 30 seconds.'
    );

    res.json(result);
  } catch (error) {
    console.error('[ContentHarvester] Harvest failed:', error);

    const message = error && error.message ? error.message : 'Harvest failed';
    const isUserError =
      message.includes('URL is required') ||
      message.includes('Invalid URL') ||
      message.includes('Only HTTP/HTTPS protocols are allowed.');

    const status = isUserError
      ? 400
      : message.includes('unreachable') || message.includes('timeout')
      ? 502
      : 500;

    res.status(status).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[EliteScanner] Server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[EliteScanner] SIGTERM received, shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[EliteScanner] SIGINT received, shutting down.');
  process.exit(0);
});
