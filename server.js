const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || '*', // Allow all origins if FRONTEND_URL not set
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'sitesweep-scanner' });
});

// Scan endpoint
app.post('/scan', async (req, res) => {
  let browser = null;
  
  try {
    const { url, jobId } = req.body;

    // Validate URL
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'URL is required and must be a string',
      });
    }

    // Validate URL format
    let targetUrl;
    try {
      targetUrl = new URL(url);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format. Must be http:// or https://',
      });
    }

    console.log(`[Scanner] Starting scan for ${url} (Job ID: ${jobId || 'N/A'})`);

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SiteSweep/1.0',
    });

    const page = await context.newPage();

    // Set timeout for page operations
    page.setDefaultTimeout(30000); // 30 seconds

    // Navigate to URL
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    } catch (navError) {
      throw new Error(`Failed to navigate to URL: ${navError.message}`);
    }

    if (!response) {
      throw new Error('No response received from URL');
    }

    // Wait for page to be fully loaded
    await page.waitForLoadState('domcontentloaded');

    // Collect page data
    const pageData = await page.evaluate(() => {
      const getMetaContent = (name) => {
        const meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return meta ? meta.getAttribute('content') : null;
      };

      const getViewportMeta = () => {
        const viewport = document.querySelector('meta[name="viewport"]');
        return viewport ? viewport.getAttribute('content') : null;
      };

      const checkKeyword = (keyword) => {
        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
        return bodyText.includes(keyword.toLowerCase());
      };

      return {
        title: document.title || '',
        url: window.location.href,
        protocol: window.location.protocol,
        viewportMeta: getViewportMeta(),
        hasImpressum: checkKeyword('Impressum') || checkKeyword('Imprint'),
        hasDatenschutz: checkKeyword('Datenschutz') || checkKeyword('Privacy') || checkKeyword('Datenschutzerklärung'),
        hasCookieBanner: checkKeyword('Cookie') || checkKeyword('Cookies'),
        metaDescription: getMetaContent('description'),
        htmlLang: document.documentElement.lang || null,
      };
    });

    // Perform checks and generate issues
    const issues = [];
    let score = 100;

    // Check 1: Title
    if (!pageData.title || pageData.title.trim().length === 0) {
      issues.push({
        id: 'missing-title',
        category: 'seo',
        title: 'Fehlender Seitentitel',
        description: 'Die Seite hat keinen Titel. Dies beeinträchtigt SEO und die Benutzerfreundlichkeit.',
        severity: 'high',
        pages: [url],
      });
      score -= 10;
    } else if (pageData.title.length < 30) {
      issues.push({
        id: 'title-too-short',
        category: 'seo',
        title: 'Seitentitel zu kurz',
        description: `Der Seitentitel ist nur ${pageData.title.length} Zeichen lang. Empfohlen: 50-60 Zeichen für optimale SEO.`,
        severity: 'medium',
        pages: [url],
      });
      score -= 5;
    }

    // Check 2: SSL/HTTPS
    if (pageData.protocol !== 'https:') {
      issues.push({
        id: 'no-ssl',
        category: 'technical',
        title: 'Keine SSL-Verschlüsselung',
        description: 'Die Website verwendet kein HTTPS. Dies ist ein Sicherheitsrisiko und wird von Browsern als "Nicht sicher" markiert.',
        severity: 'high',
        pages: [url],
      });
      score -= 20;
    }

    // Check 3: Viewport Meta Tag (Mobile)
    if (!pageData.viewportMeta) {
      issues.push({
        id: 'missing-viewport',
        category: 'ux',
        title: 'Fehlender Viewport Meta-Tag',
        description: 'Die Seite hat keinen Viewport Meta-Tag. Dies führt zu Problemen auf mobilen Geräten.',
        severity: 'high',
        pages: [url],
      });
      score -= 15;
    } else {
      // Check if viewport is mobile-friendly
      const viewportLower = pageData.viewportMeta.toLowerCase();
      if (!viewportLower.includes('width=device-width')) {
        issues.push({
          id: 'viewport-not-mobile',
          category: 'ux',
          title: 'Viewport nicht mobil-optimiert',
          description: 'Der Viewport Meta-Tag ist nicht für mobile Geräte optimiert.',
          severity: 'medium',
          pages: [url],
        });
        score -= 10;
      }
    }

    // Check 4: Impressum
    if (!pageData.hasImpressum) {
      issues.push({
        id: 'missing-impressum',
        category: 'legal',
        title: 'Kein Impressum gefunden',
        description: 'Auf der Seite wurde kein Impressum gefunden. Dies ist in Deutschland für gewerbliche Websites gesetzlich vorgeschrieben.',
        severity: 'high',
        pages: [url],
      });
      score -= 15;
    }

    // Check 5: Datenschutz
    if (!pageData.hasDatenschutz) {
      issues.push({
        id: 'missing-datenschutz',
        category: 'legal',
        title: 'Keine Datenschutzerklärung gefunden',
        description: 'Auf der Seite wurde keine Datenschutzerklärung gefunden. Dies ist nach DSGVO gesetzlich vorgeschrieben.',
        severity: 'high',
        pages: [url],
      });
      score -= 15;
    }

    // Check 6: Meta Description
    if (!pageData.metaDescription) {
      issues.push({
        id: 'missing-meta-description',
        category: 'seo',
        title: 'Fehlende Meta-Beschreibung',
        description: 'Die Seite hat keine Meta-Beschreibung. Dies beeinträchtigt SEO und die Darstellung in Suchmaschinen.',
        severity: 'medium',
        pages: [url],
      });
      score -= 5;
    }

    // Ensure score is not negative
    score = Math.max(0, score);

    // Generate summary
    const highIssues = issues.filter(i => i.severity === 'high').length;
    const mediumIssues = issues.filter(i => i.severity === 'medium').length;
    const lowIssues = issues.filter(i => i.severity === 'low').length;

    const summary = `Analyse abgeschlossen. ${issues.length} Problem${issues.length !== 1 ? 'e' : ''} gefunden: ${highIssues} kritisch, ${mediumIssues} mittel, ${lowIssues} niedrig.`;

    // Calculate score breakdown
    const scoreBreakdown = {
      technical: 100,
      seo: 100,
      legal: 100,
      ux: 100,
    };

    // Adjust breakdown based on issues
    issues.forEach(issue => {
      const penalty = issue.severity === 'high' ? 20 : issue.severity === 'medium' ? 10 : 5;
      if (scoreBreakdown[issue.category]) {
        scoreBreakdown[issue.category] = Math.max(0, scoreBreakdown[issue.category] - penalty);
      }
    });

    console.log(`[Scanner] Scan completed for ${url}. Score: ${score}, Issues: ${issues.length}`);

    // Return result
    res.json({
      success: true,
      data: {
        score,
        summary,
        issues,
        scoreBreakdown,
        scoreRaw: score,
        mobileScreenshotUrl: null, // Screenshot generation can be added later
      },
    });

  } catch (error) {
    console.error('[Scanner] Error during scan:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'An error occurred during scanning',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    // Always close browser
    if (browser) {
      try {
        await browser.close();
        console.log('[Scanner] Browser closed');
      } catch (closeError) {
        console.error('[Scanner] Error closing browser:', closeError);
      }
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`[Scanner] Server running on port ${PORT}`);
  console.log(`[Scanner] Health check: http://localhost:${PORT}/health`);
  console.log(`[Scanner] Scan endpoint: http://localhost:${PORT}/scan`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Scanner] SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Scanner] SIGINT received, shutting down gracefully');
  process.exit(0);
});

