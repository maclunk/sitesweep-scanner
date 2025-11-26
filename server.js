const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
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

const normalizeUrl = (rawUrl = '') => {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
};

const buildIssue = (category, severity, message) => ({
  category,
  severity,
  message,
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sitesweep-scanner' });
});

app.post('/scan', async (req, res) => {
  let browser;

  try {
    const normalized = normalizeUrl(req.body?.url || '');
    let targetUrl;
    try {
      targetUrl = new URL(normalized);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        throw new Error('Only HTTP/HTTPS protocols are allowed.');
      }
    } catch (err) {
      return res.status(400).json({ error: 'Invalid URL. Provide a valid http(s) URL.' });
    }

    console.log(`[EliteScanner] Starting scan for ${targetUrl.href}`);

    browser = await chromium.launch({ headless: true, args: HEADLESS_ARGS });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
    });

    const gdprFindings = {
      googleFonts: false,
      googleMaps: false,
    };

    await context.route('**/*', async (route) => {
      try {
        const reqUrl = route.request().url();
        if (/fonts\.g(static|oogleapis)\.com/i.test(reqUrl)) {
          gdprFindings.googleFonts = true;
        }
        if (/maps\.(googleapis|gstatic)\.com/i.test(reqUrl)) {
          gdprFindings.googleMaps = true;
        }
        await route.continue();
      } catch (routeError) {
        console.warn('[EliteScanner] Route interception error:', routeError.message);
        try {
          await route.continue();
        } catch {
          /* no-op */
        }
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    await page.goto(targetUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT_MS,
    });
    await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});

    const finalUrl = page.url();
    const finalProtocol = (() => {
      try {
        return new URL(finalUrl).protocol;
      } catch {
        return 'http:';
      }
    })();

    const pageData = await page.evaluate(() => {
      const lowerHtml = document.documentElement.innerHTML.toLowerCase();
      const anchors = Array.from(document.querySelectorAll('a'));
      const hasImpressumLink = anchors.some((a) => (a.textContent || '').toLowerCase().includes('impressum'));
      const techStack = new Set();

      if (lowerHtml.includes('wp-content')) techStack.add('WordPress');
      if (lowerHtml.includes('wixstatic.com') || lowerHtml.includes('wixsite.com')) techStack.add('Wix');
      if (lowerHtml.includes('jimstatic.com') || lowerHtml.includes('jimdo')) techStack.add('Jimdo');
      if (lowerHtml.includes('squarespace')) techStack.add('Squarespace');
      if (lowerHtml.includes('shopify')) techStack.add('Shopify');
      if (lowerHtml.includes('google-analytics') || lowerHtml.includes('gtag(') || lowerHtml.includes('gtm.js')) {
        techStack.add('Google Analytics');
      }

      return {
        title: document.title?.trim() || '',
        metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '',
        hasViewportMeta: Boolean(document.querySelector('meta[name="viewport"]')),
        hasImpressumLink,
        h1Count: document.querySelectorAll('h1').length,
        techStack: Array.from(techStack),
      };
    });

    const issues = [];
    let score = 100;
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
        buildIssue('gdpr', 'high', 'Google Fonts werden extern geladen (mögliche DSGVO-Verletzung).')
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
    } catch (shotError) {
      console.warn('[EliteScanner] Screenshot failed:', shotError.message);
    }

    const techStack = Array.from(new Set(pageData.techStack));

    res.json({
      url: targetUrl.href,
      finalUrl,
      score,
      screenshot: screenshotBase64,
      issues,
      techStack,
    });
  } catch (error) {
    console.error('[EliteScanner] Scan failed:', error);
    res.status(500).json({ error: error.message || 'Scan failed' });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[EliteScanner] Browser close error:', closeError);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`[EliteScanner] Server listening on ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[EliteScanner] SIGTERM received, shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[EliteScanner] SIGINT received, shutting down.');
  process.exit(0);
});
