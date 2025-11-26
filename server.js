/**
 * ============================================================================
 * ELITE SCANNER SERVICE - Deep Technical Audit for SME Websites
 * ============================================================================
 * Performs comprehensive website analysis targeting pain points for:
 * - Lawyers (Legal compliance, Impressum)
 * - Doctors (Privacy, GDPR)
 * - Craftsmen (Mobile-first, SEO basics)
 * 
 * Features:
 * - SSL/HTTPS Security Check
 * - Mobile Responsiveness Detection
 * - Legal Compliance (Impressum)
 * - GDPR Violation Detection (Google Fonts/Maps)
 * - SEO Analysis (Title, Description, Headings)
 * - Technology Stack Detection
 * - Performance & Accessibility Insights
 * ============================================================================
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds max per scan
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Chromium launch arguments optimized for Docker/Cloud environments
const HEADLESS_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-default-apps',
];

const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalizes a user-provided URL
 * - Adds https:// if no protocol specified
 * - Validates format
 */
const normalizeUrl = (rawUrl = '') => {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }

  // Add https:// if no protocol specified
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
};

/**
 * Creates a standardized issue object with title and message
 */
const buildIssue = (category, severity, title, message) => ({
  category,
  severity,
  title,
  message,
});

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Health check endpoint
 */
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'sitesweep-scanner-elite',
    version: '2.0.0'
  });
});

/**
 * Main scanning endpoint - performs deep technical audit
 */
app.post('/scan', async (req, res) => {
  let browser;
  const scanStartTime = Date.now();

  try {
    // ========================================================================
    // STEP 1: URL Validation & Normalization
    // ========================================================================
    
    const normalized = normalizeUrl(req.body?.url || '');
    let targetUrl;
    
    try {
      targetUrl = new URL(normalized);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        throw new Error('Only HTTP/HTTPS protocols are allowed.');
      }
    } catch (err) {
      return res.status(400).json({ 
        error: 'Invalid URL. Provide a valid http(s) URL.',
        details: err.message
      });
    }

    console.log(`[EliteScanner] 🔍 Starting deep scan for: ${targetUrl.href}`);

    // ========================================================================
    // STEP 2: Browser Setup with Request Interception
    // ========================================================================
    
    browser = await chromium.launch({ 
      headless: true, 
      args: HEADLESS_ARGS,
      timeout: DEFAULT_TIMEOUT_MS 
    });
    
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true, // Allow scanning sites with invalid SSL
    });

    // GDPR tracking: Monitor external resource loading
    const gdprFindings = {
      googleFonts: false,
      googleMaps: false,
      googleAnalytics: false,
      facebookPixel: false,
    };

    const requestUrls = [];

    // Intercept ALL network requests to detect GDPR violations
    await context.route('**/*', async (route) => {
      try {
        const reqUrl = route.request().url();
        requestUrls.push(reqUrl);

        // Check for Google Fonts (CRITICAL GDPR violation in Germany/EU)
        if (/fonts\.g(static|oogleapis)\.com/i.test(reqUrl)) {
          gdprFindings.googleFonts = true;
        }

        // Check for Google Maps
        if (/maps\.(googleapis|gstatic)\.com/i.test(reqUrl)) {
          gdprFindings.googleMaps = true;
        }

        // Check for Google Analytics
        if (/google-analytics\.com|googletagmanager\.com/i.test(reqUrl)) {
          gdprFindings.googleAnalytics = true;
        }

        // Check for Facebook Pixel
        if (/facebook\.com\/tr|connect\.facebook\.net/i.test(reqUrl)) {
          gdprFindings.facebookPixel = true;
        }

        await route.continue();
      } catch (routeError) {
        console.warn('[EliteScanner] ⚠️  Route interception error:', routeError.message);
        try {
          await route.continue();
        } catch {
          // Silently fail if route already handled
        }
      }
    });

    // ========================================================================
    // STEP 3: Page Navigation & Content Loading
    // ========================================================================
    
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    let navigationError = null;
    
    try {
      await page.goto(targetUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
      });
      
      // Wait for network to be idle (best effort, non-blocking)
      await page.waitForLoadState('networkidle', { 
        timeout: DEFAULT_TIMEOUT_MS 
      }).catch(() => {
        console.log('[EliteScanner] ℹ️  Network did not become idle, continuing...');
      });
    } catch (navError) {
      navigationError = navError.message;
      console.error('[EliteScanner] ❌ Navigation error:', navError.message);
      
      // If we can't load the page at all, return early
      if (!page.url() || page.url() === 'about:blank') {
        throw new Error(`Could not load website: ${navError.message}`);
      }
    }

    const finalUrl = page.url();
    const finalProtocol = (() => {
      try {
        return new URL(finalUrl).protocol;
      } catch {
        return 'http:';
      }
    })();

    console.log(`[EliteScanner] 📄 Final URL: ${finalUrl} (Protocol: ${finalProtocol})`);

    // ========================================================================
    // STEP 4: Deep Page Analysis (In-Browser JavaScript)
    // ========================================================================
    
    const pageData = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const lowerHtml = html.toLowerCase();
      const bodyText = document.body?.textContent || '';
      
      // Legal compliance: Check for Impressum link
      const anchors = Array.from(document.querySelectorAll('a'));
      const impressumLink = anchors.find((a) => 
        (a.textContent || '').toLowerCase().includes('impressum')
      );
      const hasImpressumLink = Boolean(impressumLink);
      const impressumUrl = impressumLink ? impressumLink.href : null;

      // Check for other legal pages
      const datenschutzLink = anchors.find((a) => 
        (a.textContent || '').toLowerCase().includes('datenschutz')
      );
      const hasDatenschutzLink = Boolean(datenschutzLink);

      // Technology detection
      const techStack = new Set();
      
      // CMS Detection
      if (lowerHtml.includes('wp-content') || lowerHtml.includes('wp-includes')) {
        techStack.add('WordPress');
      }
      if (lowerHtml.includes('wixstatic.com') || lowerHtml.includes('wixsite.com')) {
        techStack.add('Wix');
      }
      if (lowerHtml.includes('jimstatic.com') || lowerHtml.includes('jimdo')) {
        techStack.add('Jimdo');
      }
      if (lowerHtml.includes('squarespace')) {
        techStack.add('Squarespace');
      }
      if (lowerHtml.includes('shopify') || lowerHtml.includes('myshopify.com')) {
        techStack.add('Shopify');
      }
      if (lowerHtml.includes('typo3')) {
        techStack.add('TYPO3');
      }
      if (lowerHtml.includes('drupal')) {
        techStack.add('Drupal');
      }
      if (lowerHtml.includes('joomla')) {
        techStack.add('Joomla');
      }

      // Framework Detection
      if (lowerHtml.includes('react') || lowerHtml.includes('_react')) {
        techStack.add('React');
      }
      if (lowerHtml.includes('vue') || lowerHtml.includes('__vue__')) {
        techStack.add('Vue.js');
      }
      if (lowerHtml.includes('angular') || lowerHtml.includes('ng-version')) {
        techStack.add('Angular');
      }
      if (lowerHtml.includes('next.js') || lowerHtml.includes('__next')) {
        techStack.add('Next.js');
      }

      // Analytics & Marketing
      if (lowerHtml.includes('google-analytics') || lowerHtml.includes('gtag(') || lowerHtml.includes('gtm.js')) {
        techStack.add('Google Analytics');
      }
      if (lowerHtml.includes('matomo') || lowerHtml.includes('piwik')) {
        techStack.add('Matomo');
      }
      if (lowerHtml.includes('facebook.com/tr') || lowerHtml.includes('fbq(')) {
        techStack.add('Facebook Pixel');
      }
      if (lowerHtml.includes('hotjar')) {
        techStack.add('Hotjar');
      }

      // SEO Analysis
      const title = document.title?.trim() || '';
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
      const metaKeywords = document.querySelector('meta[name="keywords"]')?.getAttribute('content')?.trim() || '';
      const canonicalLink = document.querySelector('link[rel="canonical"]')?.href || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      
      // Mobile responsiveness
      const hasViewportMeta = Boolean(document.querySelector('meta[name="viewport"]'));
      const viewportContent = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';

      // Heading structure
      const h1Elements = Array.from(document.querySelectorAll('h1'));
      const h1Count = h1Elements.length;
      const h1Texts = h1Elements.map(h => h.textContent?.trim()).filter(Boolean);
      const h2Count = document.querySelectorAll('h2').length;
      const h3Count = document.querySelectorAll('h3').length;

      // Images analysis
      const images = Array.from(document.querySelectorAll('img'));
      const imagesWithoutAlt = images.filter(img => !img.alt || img.alt.trim() === '').length;
      const totalImages = images.length;

      // Language detection
      const htmlLang = document.documentElement.lang || '';

      // Form detection (contact forms are crucial for SMEs)
      const hasContactForm = document.querySelectorAll('form').length > 0;

      // Performance indicators
      const externalScripts = Array.from(document.querySelectorAll('script[src]')).length;
      const inlineScripts = Array.from(document.querySelectorAll('script:not([src])')).length;
      const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).length;

      return {
        // Legal
        hasImpressumLink,
        impressumUrl,
        hasDatenschutzLink,
        
        // SEO
        title,
        metaDescription,
        metaKeywords,
        canonicalLink,
        ogTitle,
        ogDescription,
        ogImage,
        h1Count,
        h1Texts,
        h2Count,
        h3Count,
        
        // Mobile
        hasViewportMeta,
        viewportContent,
        
        // Accessibility
        totalImages,
        imagesWithoutAlt,
        htmlLang,
        
        // Features
        hasContactForm,
        
        // Performance
        externalScripts,
        inlineScripts,
        stylesheets,
        
        // Tech
        techStack: Array.from(techStack),
      };
    });

    console.log(`[EliteScanner] 📊 Page data extracted:`, {
      title: pageData.title,
      h1Count: pageData.h1Count,
      hasImpressum: pageData.hasImpressumLink,
      techStack: pageData.techStack,
    });

    // ========================================================================
    // STEP 5: Issue Detection & Scoring
    // ========================================================================
    
    const issues = [];
    let score = 100; // Start with perfect score
    
    const applyPenalty = (amount, reason) => {
      const oldScore = score;
      score = Math.max(0, score - amount);
      console.log(`[EliteScanner] 💯 Score: ${oldScore} → ${score} (-${amount}) | ${reason}`);
    };

    // --- SECURITY CHECKS ---
    
    if (finalProtocol !== 'https:') {
      issues.push(
        buildIssue(
          'security', 
          'high',
          'Keine SSL-Verschlüsselung',
          'Webseite ist nicht verschlüsselt (kein HTTPS). Dies ist unsicher und schadet dem Vertrauen.'
        )
      );
      applyPenalty(40, 'Missing HTTPS');
    }

    // --- MOBILE CHECKS ---
    
    if (!pageData.hasViewportMeta) {
      issues.push(
        buildIssue(
          'mobile', 
          'high',
          'Nicht mobile-optimiert',
          'Kein responsiver Viewport-Meta-Tag gefunden. Webseite ist nicht für Mobilgeräte optimiert.'
        )
      );
      applyPenalty(20, 'No viewport meta tag');
    } else if (!pageData.viewportContent.includes('width=device-width')) {
      issues.push(
        buildIssue(
          'mobile', 
          'medium',
          'Viewport-Konfiguration suboptimal',
          'Viewport-Meta-Tag ist nicht optimal konfiguriert.'
        )
      );
      applyPenalty(5, 'Suboptimal viewport config');
    }

    // --- LEGAL COMPLIANCE CHECKS (CRITICAL FOR GERMANY/EU) ---
    
    if (!pageData.hasImpressumLink) {
      issues.push(
        buildIssue(
          'legal', 
          'critical',
          'Impressum fehlt',
          'Kein Impressum-Link gefunden. Dies ist in Deutschland gesetzlich vorgeschrieben (§5 TMG)!'
        )
      );
      applyPenalty(30, 'Missing Impressum');
    }

    if (!pageData.hasDatenschutzLink) {
      issues.push(
        buildIssue(
          'legal', 
          'high',
          'Datenschutzerklärung fehlt',
          'Kein Datenschutz-Link gefunden. DSGVO-Verstoß!'
        )
      );
      applyPenalty(15, 'Missing Privacy Policy');
    }

    // --- GDPR VIOLATION CHECKS ---
    
    if (gdprFindings.googleFonts) {
      issues.push(
        buildIssue(
          'gdpr', 
          'high',
          'Google Fonts werden illegal geladen',
          'Ihre Seite lädt Schriften direkt von US-Servern. Das verstößt gegen die DSGVO (EuGH-Urteil). Schriftarten sollten lokal gehostet werden.'
        )
      );
      applyPenalty(20, 'Google Fonts GDPR violation');
    }

    if (gdprFindings.googleMaps) {
      issues.push(
        buildIssue(
          'gdpr', 
          'medium',
          'Google Maps ohne Consent',
          'Google Maps wird ohne Consent-Management eingebunden. Möglicher DSGVO-Verstoß.'
        )
      );
      applyPenalty(10, 'Google Maps without consent');
    }

    if (gdprFindings.googleAnalytics) {
      issues.push(
        buildIssue(
          'gdpr', 
          'medium',
          'Google Analytics erkannt',
          'Google Analytics erkannt. Stellen Sie sicher, dass ein Cookie-Banner aktiv ist.'
        )
      );
      applyPenalty(5, 'Google Analytics detected');
    }

    if (gdprFindings.facebookPixel) {
      issues.push(
        buildIssue(
          'gdpr', 
          'medium',
          'Facebook Pixel erkannt',
          'Facebook Pixel erkannt. Benötigt explizite Nutzereinwilligung (DSGVO).'
        )
      );
      applyPenalty(5, 'Facebook Pixel detected');
    }

    // --- SEO CHECKS ---
    
    // Title check
    if (!pageData.title) {
      issues.push(
        buildIssue(
          'seo', 
          'medium',
          'Seitentitel fehlt',
          'Seitentitel fehlt komplett. Wichtig für Suchmaschinen!'
        )
      );
      applyPenalty(5, 'Missing title');
    } else if (pageData.title.length < 10) {
      issues.push(
        buildIssue(
          'seo', 
          'medium',
          'Seitentitel zu kurz',
          `Seitentitel ist zu kurz (${pageData.title.length} Zeichen). Empfohlen: 50-60 Zeichen.`
        )
      );
      applyPenalty(5, 'Title too short');
    } else if (pageData.title.length > 70) {
      issues.push(
        buildIssue(
          'seo', 
          'low',
          'Seitentitel zu lang',
          `Seitentitel ist zu lang (${pageData.title.length} Zeichen). Google kürzt nach ~60 Zeichen.`
        )
      );
      applyPenalty(3, 'Title too long');
    }

    // Meta description check
    if (!pageData.metaDescription) {
      issues.push(
        buildIssue(
          'seo', 
          'medium',
          'Meta-Description fehlt',
          'Meta-Description fehlt. Wichtig für Suchergebnisse!'
        )
      );
      applyPenalty(5, 'Missing meta description');
    } else if (pageData.metaDescription.length < 50) {
      issues.push(
        buildIssue(
          'seo', 
          'low',
          'Meta-Description zu kurz',
          `Meta-Description ist zu kurz (${pageData.metaDescription.length} Zeichen). Empfohlen: 150-160 Zeichen.`
        )
      );
      applyPenalty(3, 'Meta description too short');
    }

    // H1 structure check
    if (pageData.h1Count === 0) {
      issues.push(
        buildIssue(
          'seo', 
          'medium',
          'H1-Überschrift fehlt',
          'Keine H1-Überschrift gefunden. Wichtig für SEO-Struktur!'
        )
      );
      applyPenalty(5, 'Missing H1');
    } else if (pageData.h1Count > 1) {
      issues.push(
        buildIssue(
          'seo', 
          'medium',
          'Mehrere H1-Überschriften',
          `Mehrere H1-Überschriften gefunden (${pageData.h1Count}). Es sollte nur eine H1 pro Seite geben.`
        )
      );
      applyPenalty(5, 'Multiple H1 tags');
    }

    // Language tag check
    if (!pageData.htmlLang) {
      issues.push(
        buildIssue(
          'seo', 
          'low',
          'Sprachattribut fehlt',
          'HTML-Sprachattribut fehlt. Sollte gesetzt werden für bessere Barrierefreiheit.'
        )
      );
      applyPenalty(2, 'Missing language tag');
    }

    // Open Graph check (important for social media sharing)
    if (!pageData.ogTitle && !pageData.ogDescription) {
      issues.push(
        buildIssue(
          'seo', 
          'low',
          'Open Graph Tags fehlen',
          'Open Graph Tags fehlen. Wichtig für Social Media Sharing (Facebook, LinkedIn).'
        )
      );
      applyPenalty(3, 'Missing Open Graph tags');
    }

    // --- ACCESSIBILITY CHECKS ---
    
    if (pageData.totalImages > 0 && pageData.imagesWithoutAlt > 0) {
      const percentage = Math.round((pageData.imagesWithoutAlt / pageData.totalImages) * 100);
      issues.push(
        buildIssue(
          'accessibility', 
          'medium',
          'Bilder ohne Alt-Text',
          `${pageData.imagesWithoutAlt} von ${pageData.totalImages} Bildern haben keinen Alt-Text (${percentage}%). Wichtig für Barrierefreiheit!`
        )
      );
      applyPenalty(5, 'Images without alt text');
    }

    // --- PERFORMANCE WARNINGS (informational, minor penalties) ---
    
    if (pageData.externalScripts > 10) {
      issues.push(
        buildIssue(
          'performance', 
          'low',
          'Viele externe Skripte',
          `Viele externe Skripte (${pageData.externalScripts}). Dies kann die Ladezeit verlangsamen.`
        )
      );
      applyPenalty(2, 'Many external scripts');
    }

    // --- POSITIVE FINDINGS (no penalty, but good to mention) ---
    
    if (pageData.hasContactForm) {
      console.log('[EliteScanner] ✅ Contact form detected');
    }

    if (pageData.canonicalLink) {
      console.log('[EliteScanner] ✅ Canonical link present');
    }

    // ========================================================================
    // STEP 6: Screenshot Capture
    // ========================================================================
    
    let screenshotDataUrl = null;
    try {
      const screenshotBuffer = await page.screenshot({
        fullPage: false, // Only capture "above the fold" viewport
        type: 'jpeg',
        quality: 60,
        timeout: 10000, // 10s timeout for screenshot
      });
      const base64String = screenshotBuffer.toString('base64');
      screenshotDataUrl = `data:image/jpeg;base64,${base64String}`;
      console.log('[EliteScanner] 📸 Screenshot captured successfully');
    } catch (shotError) {
      console.warn('[EliteScanner] ⚠️  Screenshot failed:', shotError.message);
      // Don't fail the scan if screenshot fails
    }

    // ========================================================================
    // STEP 7: Final Tech Stack Compilation
    // ========================================================================
    
    const techStack = Array.from(new Set([
      ...pageData.techStack,
      ...(gdprFindings.googleAnalytics ? ['Google Analytics'] : []),
      ...(gdprFindings.facebookPixel ? ['Facebook Pixel'] : []),
    ]));

    // ========================================================================
    // STEP 8: Response Compilation (Exact Format)
    // ========================================================================
    
    const scanDuration = Date.now() - scanStartTime;
    console.log(`[EliteScanner] ✅ Scan completed in ${scanDuration}ms | Score: ${score}/100`);

    const response = {
      url: targetUrl.href,
      finalUrl,
      score,
      screenshot: screenshotDataUrl,
      meta: {
        title: pageData.title || '',
        description: pageData.metaDescription || '',
      },
      techStack,
      issues,
    };

    res.json(response);

  } catch (error) {
    // ========================================================================
    // ERROR HANDLING - Never crash the server
    // ========================================================================
    
    console.error('[EliteScanner] ❌ SCAN FAILED:', error);
    
    const errorResponse = {
      error: 'Scan failed',
      message: error.message || 'Unknown error occurred',
      url: req.body?.url || 'unknown',
      timestamp: new Date().toISOString(),
    };

    // Determine appropriate status code
    if (error.message?.includes('timeout') || error.message?.includes('Timeout')) {
      errorResponse.code = 'TIMEOUT';
      return res.status(504).json(errorResponse);
    } else if (error.message?.includes('net::ERR')) {
      errorResponse.code = 'NETWORK_ERROR';
      return res.status(503).json(errorResponse);
    } else {
      errorResponse.code = 'INTERNAL_ERROR';
      return res.status(500).json(errorResponse);
    }

  } finally {
    // ========================================================================
    // CLEANUP - Always close browser
    // ========================================================================
    
    if (browser) {
      try {
        await browser.close();
        console.log('[EliteScanner] 🧹 Browser closed');
      } catch (closeError) {
        console.error('[EliteScanner] ⚠️  Browser close error:', closeError.message);
      }
    }
  }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🚀 ELITE SCANNER SERVICE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📡 Server listening on port: ${PORT}`);
  console.log(`⏱️  Timeout: ${DEFAULT_TIMEOUT_MS}ms`);
  console.log(`🌐 CORS: ${process.env.FRONTEND_URL || 'All origins'}`);
  console.log('═══════════════════════════════════════════════════════════');
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGTERM', () => {
  console.log('[EliteScanner] 🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[EliteScanner] 🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// ============================================================================
// UNHANDLED ERRORS - Log but don't crash
// ============================================================================

process.on('unhandledRejection', (reason, promise) => {
  console.error('[EliteScanner] ⚠️  Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[EliteScanner] ⚠️  Uncaught Exception:', error);
  // In production, you might want to exit here, but for now we log and continue
});
