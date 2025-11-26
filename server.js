'use strict';

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Basic setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 8080;

// Timeouts
const SCAN_TIMEOUT_MS = 30_000;   // 30 seconds for /scan
const HARVEST_TIMEOUT_MS = 45_000; // 45 seconds for /harvest (multi-page)

// Desktop Chrome user agent
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Safe headless flags
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

/**
 * Resolve relative URL to absolute URL
 */
function resolveUrl(baseUrl, relativeUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return relativeUrl; // Return as-is if can't resolve
  }
}

/**
 * Extract emails from text using regex
 */
function extractEmails(text) {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  const matches = text.match(emailRegex) || [];
  return [...new Set(matches)];
}

/**
 * Extract phone numbers from text
 */
function extractPhones(text) {
  const phoneRegex = /(\+?\d{1,4}[\s\-\.]?)?\(?\d{2,4}\)?[\s\-\.]?\d{3,4}[\s\-\.]?\d{3,4}/g;
  const matches = text.match(phoneRegex) || [];
  // Filter out false positives
  return [...new Set(matches.filter(p => p.replace(/\D/g, '').length >= 8))];
}

/**
 * Check if URL is internal (same domain)
 */
function isInternalUrl(baseUrl, testUrl) {
  try {
    const base = new URL(baseUrl);
    const test = new URL(testUrl, baseUrl);
    return base.hostname === test.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core scan logic (existing /scan endpoint)
// ---------------------------------------------------------------------------

/**
 * Perform the elite scan for a single URL.
 */
async function performScan(inputUrl) {
  let browser;

  try {
    const targetUrl = normalizeUrl(inputUrl);
    console.log(`[EliteScanner] Starting scan for ${targetUrl.href}`);

    browser = await chromium.launch({
      headless: true,
      args: HEADLESS_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
    });

    // GDPR tracking
    const gdprFindings = {
      googleFonts: false,
      googleMaps: false,
    };

    await context.route('**/*', async (route) => {
      try {
        const reqUrl = route.request().url();

        if (/fonts\.googleapis\.com/i.test(reqUrl) || /fonts\.gstatic\.com/i.test(reqUrl)) {
          gdprFindings.googleFonts = true;
        }

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
    page.setDefaultTimeout(SCAN_TIMEOUT_MS);

    try {
      await page.goto(targetUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: SCAN_TIMEOUT_MS,
      });
      await page.waitForLoadState('networkidle', { timeout: SCAN_TIMEOUT_MS }).catch(() => {});
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

    const pageData = await page.evaluate(() => {
      const html = document.documentElement?.innerHTML || '';
      const lowerHtml = html.toLowerCase();

      const anchors = Array.from(document.querySelectorAll('a'));
      const hasImpressumLink = anchors.some((a) =>
        (a.textContent || '').toLowerCase().includes('impressum')
      );

      const techStackSet = new Set();

      if (lowerHtml.includes('wp-content')) techStackSet.add('WordPress');
      if (lowerHtml.includes('wixstatic.com') || lowerHtml.includes('wixsite.com'))
        techStackSet.add('Wix');
      if (lowerHtml.includes('jimstatic.com') || lowerHtml.includes('jimdo'))
        techStackSet.add('Jimdo');
      if (lowerHtml.includes('squarespace')) techStackSet.add('Squarespace');
      if (lowerHtml.includes('shopify')) techStackSet.add('Shopify');

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

    let score = 100;
    const issues = [];

    const applyPenalty = (amount) => {
      score = Math.max(0, score - amount);
    };

    if (finalProtocol !== 'https:') {
      issues.push(
        buildIssue('security', 'high', 'Webseite ist nicht verschlüsselt (kein HTTPS).')
      );
      applyPenalty(40);
    }

    if (!pageData.hasViewportMeta) {
      issues.push(
        buildIssue('mobile', 'high', 'Kein responsiver Viewport-Meta-Tag gefunden.')
      );
      applyPenalty(20);
    }

    if (!pageData.hasImpressumLink) {
      issues.push(
        buildIssue('legal', 'critical', 'Kein Impressum-Link gefunden.')
      );
      applyPenalty(30);
    }

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

    if (gdprFindings.googleMaps) {
      issues.push(
        buildIssue('gdpr', 'medium', 'Google Maps wird extern eingebunden.')
      );
    }

    if (!pageData.title || pageData.title.length < 10) {
      const lengthInfo = pageData.title ? ` (${pageData.title.length} Zeichen)` : '';
      issues.push(
        buildIssue('seo', 'medium', `Seitentitel fehlt oder ist zu kurz${lengthInfo}.`)
      );
      applyPenalty(5);
    }

    if (!pageData.metaDescription) {
      issues.push(
        buildIssue('seo', 'medium', 'Meta-Description fehlt.')
      );
      applyPenalty(5);
    }

    if (pageData.h1Count === 0 || pageData.h1Count > 1) {
      issues.push(
        buildIssue('seo', 'medium', `H1-Struktur fehlerhaft (gefunden: ${pageData.h1Count}).`)
      );
      applyPenalty(5);
    }

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

// ---------------------------------------------------------------------------
// Deep Crawler - The Vacuum (NEW)
// ---------------------------------------------------------------------------

/**
 * Extract content from a single page
 */
async function extractPageContent(page, baseUrl) {
  return await page.evaluate((base) => {
    // Helper functions inside browser context
    function extractEmails(text) {
      const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
      const matches = text.match(emailRegex) || [];
      return [...new Set(matches)];
    }

    function extractPhones(text) {
      const phoneRegex = /(\+?\d{1,4}[\s\-\.]?)?\(?\d{2,4}\)?[\s\-\.]?\d{3,4}[\s\-\.]?\d{3,4}/g;
      const matches = text.match(phoneRegex) || [];
      return [...new Set(matches.filter(p => p.replace(/\D/g, '').length >= 8))];
    }

    function resolveUrl(relativeUrl) {
      try {
        return new URL(relativeUrl, base).href;
      } catch {
        return relativeUrl;
      }
    }

    // Get page title
    const title = (document.title || '').trim();

    // Get all text content
    const bodyText = document.body?.innerText || '';

    // Extract headings
    const headings = [];
    ['h1', 'h2', 'h3'].forEach(tag => {
      Array.from(document.querySelectorAll(tag)).forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length > 0) {
          headings.push(text);
        }
      });
    });

    // Extract main content (try to avoid nav/footer)
    let content = bodyText;
    try {
      const mainContent = 
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('.content') ||
        document.querySelector('#content') ||
        document.querySelector('.main-content');
      
      if (mainContent) {
        content = mainContent.innerText || bodyText;
      }
    } catch {
      // Fallback to body text
    }

    // Clean content: remove excessive whitespace
    content = content.replace(/\s+/g, ' ').trim();

    // Extract images with FULL URL resolution
    const images = [];
    Array.from(document.querySelectorAll('img')).forEach(img => {
      const src = img.src || img.getAttribute('src');
      if (!src) return;

      // Resolve relative URLs
      const absoluteSrc = resolveUrl(src);
      
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;

      // Filter out tiny icons (< 50px)
      if (width >= 50 && height >= 50) {
        images.push({
          url: absoluteSrc,
          alt: img.alt || '',
          width,
          height,
        });
      }
    });

    // Extract contact info
    const emails = extractEmails(bodyText);
    const phones = extractPhones(bodyText);

    // Also check mailto and tel links
    Array.from(document.querySelectorAll('a[href^="mailto:"]')).forEach(a => {
      const email = (a.getAttribute('href') || '').replace('mailto:', '').split('?')[0];
      if (email) emails.push(email);
    });

    Array.from(document.querySelectorAll('a[href^="tel:"]')).forEach(a => {
      const phone = (a.getAttribute('href') || '').replace('tel:', '').trim();
      if (phone) phones.push(phone);
    });

    return {
      url: window.location.href,
      title,
      headings,
      content: content.substring(0, 3000), // First 3000 chars
      images: images.slice(0, 20), // Max 20 images per page
      emails: [...new Set(emails)],
      phones: [...new Set(phones)],
    };
  }, baseUrl);
}

/**
 * Discover internal links from a page
 */
async function discoverLinks(page, baseUrl) {
  return await page.evaluate((base) => {
    function isInternalUrl(testUrl) {
      try {
        const baseObj = new URL(base);
        const testObj = new URL(testUrl, base);
        return baseObj.hostname === testObj.hostname;
      } catch {
        return false;
      }
    }

    const links = new Set();
    const anchors = Array.from(document.querySelectorAll('a'));
    
    anchors.forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;

      // Skip common non-content links
      if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        return;
      }

      try {
        const absoluteUrl = new URL(href, base).href;
        
        // Only include internal links
        if (isInternalUrl(absoluteUrl)) {
          // Remove hash and trailing slash for deduplication
          const cleanUrl = absoluteUrl.split('#')[0].replace(/\/$/, '');
          
          // Skip PDFs, images, downloads
          if (!/\.(pdf|jpg|jpeg|png|gif|zip|rar|doc|docx)$/i.test(cleanUrl)) {
            links.add(cleanUrl);
          }
        }
      } catch {
        // Skip invalid URLs
      }
    });

    return Array.from(links);
  }, baseUrl);
}

/**
 * Extract social media links
 */
async function extractSocials(page) {
  return await page.evaluate(() => {
    const socials = [];
    const links = Array.from(document.querySelectorAll('a'));
    
    links.forEach(a => {
      const href = (a.href || '').toLowerCase();
      
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

    // Deduplicate
    const seen = new Set();
    return socials.filter(s => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
  });
}

/**
 * The Deep Crawler - visits multiple pages and extracts everything
 */
async function deepCrawl(inputUrl) {
  let browser;
  const startTime = Date.now();
  const MAX_PAGES = 10;
  const CONCURRENT_TABS = 3;

  try {
    const targetUrl = normalizeUrl(inputUrl);
    const baseUrl = targetUrl.href;
    const domain = targetUrl.hostname;

    console.log(`[DeepCrawler] Starting deep crawl for ${domain}`);

    browser = await chromium.launch({
      headless: true,
      args: HEADLESS_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
    });

    // Step 1: Visit homepage
    console.log(`[DeepCrawler] Visiting homepage: ${baseUrl}`);
    const homePage = await context.newPage();
    homePage.setDefaultTimeout(10000);

    try {
      await homePage.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      await homePage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    } catch (navError) {
      console.error(`[DeepCrawler] Failed to load homepage: ${navError.message}`);
      throw new Error('Target site unreachable or timed out.');
    }

    // Extract homepage content
    const homeContent = await extractPageContent(homePage, baseUrl);
    
    // Discover links
    const discoveredLinks = await discoverLinks(homePage, baseUrl);
    console.log(`[DeepCrawler] Discovered ${discoveredLinks.length} internal links`);

    // Extract socials
    const socials = await extractSocials(homePage);

    // Close homepage
    await homePage.close();

    // Step 2: Filter and limit links
    const uniqueLinks = [...new Set(discoveredLinks)]
      .filter(link => link !== baseUrl && link !== baseUrl + '/') // Exclude homepage
      .slice(0, MAX_PAGES); // Limit to 10 pages

    console.log(`[DeepCrawler] Will visit ${uniqueLinks.length} subpages`);

    // Step 3: Visit subpages with concurrency control
    const subpageContents = [];
    
    for (let i = 0; i < uniqueLinks.length; i += CONCURRENT_TABS) {
      const batch = uniqueLinks.slice(i, i + CONCURRENT_TABS);
      
      // Check if we're running out of time
      const elapsed = Date.now() - startTime;
      if (elapsed > HARVEST_TIMEOUT_MS - 10000) {
        console.log(`[DeepCrawler] Approaching timeout, stopping at ${i} pages`);
        break;
      }

      // Visit batch in parallel
      const batchPromises = batch.map(async (link) => {
        const page = await context.newPage();
        page.setDefaultTimeout(8000);

        try {
          console.log(`[DeepCrawler] Visiting: ${link}`);
          await page.goto(link, {
            waitUntil: 'domcontentloaded',
            timeout: 8000,
          });
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

          const content = await extractPageContent(page, baseUrl);
          return content;
        } catch (error) {
          console.warn(`[DeepCrawler] Failed to load ${link}: ${error.message}`);
          return null;
        } finally {
          await page.close().catch(() => {});
        }
      });

      const batchResults = await Promise.all(batchPromises);
      subpageContents.push(...batchResults.filter(Boolean));
    }

    // Step 4: Aggregate all data
    const allPages = [homeContent, ...subpageContents];

    // Collect all global contact info
    const globalEmails = new Set();
    const globalPhones = new Set();

    allPages.forEach(page => {
      page.emails.forEach(e => globalEmails.add(e));
      page.phones.forEach(p => globalPhones.add(p));
    });

    // Build final response
    const result = {
      domain,
      global: {
        emails: Array.from(globalEmails),
        phones: Array.from(globalPhones),
        socials,
      },
      pages: allPages.map(page => ({
        url: page.url,
        title: page.title,
        headings: page.headings,
        content: page.content,
        images: page.images.map(img => img.url), // Just return URLs
      })),
      metadata: {
        pagesVisited: allPages.length,
        totalImages: allPages.reduce((sum, p) => sum + p.images.length, 0),
        crawlDuration: `${Date.now() - startTime}ms`,
      },
    };

    console.log(`[DeepCrawler] Crawl complete: ${result.pages.length} pages, ${result.global.emails.length} emails, ${result.metadata.totalImages} images`);

    return result;

  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[DeepCrawler] Browser close error:', closeError);
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
      SCAN_TIMEOUT_MS,
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
      deepCrawl(url),
      HARVEST_TIMEOUT_MS,
      'Harvest timeout after 45 seconds.'
    );

    res.json(result);
  } catch (error) {
    console.error('[DeepCrawler] Harvest failed:', error);

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
  console.log(`[SiteSweep] Server listening on port ${PORT}`);
  console.log(`[SiteSweep] Endpoints: /health, /scan, /harvest`);
});

process.on('SIGTERM', () => {
  console.log('[SiteSweep] SIGTERM received, shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SiteSweep] SIGINT received, shutting down.');
  process.exit(0);
});
