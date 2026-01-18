import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { logger } from '../lib/logger.js';

// ============================================================================
// Types
// ============================================================================

interface ExtractionResult {
  title: string | null;
  author: string | null;
  siteName: string | null;
  publishDate: string | null;
  content: string;
  excerpt: string | null;
  heroImage: string | null;
  wordCount: number;
  language: string;
  sourceUrl: string;
}

// ============================================================================
// Router
// ============================================================================

export const extractRouter = Router();

// ============================================================================
// Request Validation
// ============================================================================

const extractSchema = z.object({
  url: z.string().url('Invalid URL format'),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/extract
 * Extract article content from a URL using Mozilla Readability
 */
extractRouter.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Validate request
    const validation = extractSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid request',
        details: validation.error.issues,
      });
      return;
    }

    const { url } = validation.data;

    logger.info({ url }, 'Extracting content from URL');

    // Fetch the HTML content
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    if (response.status >= 400) {
      res.status(response.status).json({
        error: 'Failed to fetch URL',
        statusCode: response.status,
        message: response.status === 404 ? 'Page not found' :
                 response.status === 403 ? 'Access denied (possibly paywalled)' :
                 response.status === 401 ? 'Authentication required' :
                 'Server error',
      });
      return;
    }

    const html = response.data;

    // Parse with JSDOM
    const dom = new JSDOM(html, {
      url: url, // Needed for resolving relative URLs
    });

    const document = dom.window.document;

    // Extract metadata before Readability (it modifies the DOM)
    const metadata = extractMetadata(document, url);

    // Use Readability for main content extraction
    const reader = new Readability(document, {
      charThreshold: 100,
      keepClasses: false,
    });

    const article = reader.parse();

    if (!article || !article.textContent) {
      // Fall back to basic extraction
      const fallbackContent = extractFallbackContent(dom.window.document);
      if (!fallbackContent) {
        res.status(422).json({
          error: 'Unable to extract content',
          message: 'The page does not contain readable article content',
        });
        return;
      }

      const result: ExtractionResult = {
        title: metadata.title,
        author: metadata.author,
        siteName: metadata.siteName,
        publishDate: metadata.publishDate,
        content: fallbackContent,
        excerpt: fallbackContent.substring(0, 200) + '...',
        heroImage: metadata.heroImage,
        wordCount: countWords(fallbackContent),
        language: detectLanguage(fallbackContent),
        sourceUrl: url,
      };

      res.json(result);
      return;
    }

    // Clean up the text content
    const cleanedContent = cleanText(article.textContent);
    const wordCount = countWords(cleanedContent);

    const result: ExtractionResult = {
      title: article.title || metadata.title,
      author: article.byline || metadata.author,
      siteName: article.siteName || metadata.siteName,
      publishDate: metadata.publishDate,
      content: cleanedContent,
      excerpt: article.excerpt || cleanedContent.substring(0, 200) + '...',
      heroImage: metadata.heroImage,
      wordCount: wordCount,
      language: article.lang || detectLanguage(cleanedContent),
      sourceUrl: url,
    };

    logger.info({
      url,
      title: result.title,
      wordCount: result.wordCount,
    }, 'Successfully extracted content');

    res.json(result);
    return;

  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        res.status(408).json({
          error: 'Request timeout',
          message: 'The page took too long to load',
        });
        return;
      }
      if (error.code === 'ENOTFOUND') {
        res.status(404).json({
          error: 'Host not found',
          message: `Cannot reach the server at ${error.config?.url}`,
        });
        return;
      }
      if (error.response) {
        res.status(error.response.status).json({
          error: 'Failed to fetch URL',
          statusCode: error.response.status,
        });
        return;
      }
    }

    logger.error({ error }, 'Error extracting content');
    next(error);
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

interface Metadata {
  title: string | null;
  author: string | null;
  siteName: string | null;
  publishDate: string | null;
  heroImage: string | null;
}

function extractMetadata(document: Document, baseUrl: string): Metadata {
  const getMeta = (selectors: string[]): string | null => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const content = el.getAttribute('content') || el.textContent;
        if (content && content.trim()) {
          return content.trim();
        }
      }
    }
    return null;
  };

  // Extract title
  const title = getMeta([
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
  ]) || document.querySelector('h1')?.textContent?.trim() || document.title || null;

  // Extract author
  const author = getMeta([
    'meta[name="author"]',
    'meta[property="article:author"]',
    'meta[name="twitter:creator"]',
  ]) || document.querySelector('[rel="author"]')?.textContent?.trim() ||
     document.querySelector('.author')?.textContent?.trim() || null;

  // Extract site name
  const siteName = getMeta([
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
  ]) || new URL(baseUrl).hostname.replace('www.', '') || null;

  // Extract publish date
  const publishDate = getMeta([
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="publish-date"]',
  ]) || document.querySelector('time')?.getAttribute('datetime') || null;

  // Extract hero image
  let heroImage = getMeta([
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="thumbnail"]',
  ]);

  // Resolve relative URL for hero image
  if (heroImage && !heroImage.startsWith('http')) {
    try {
      heroImage = new URL(heroImage, baseUrl).href;
    } catch {
      heroImage = null;
    }
  }

  return {
    title,
    author,
    siteName,
    publishDate,
    heroImage,
  };
}

function extractFallbackContent(document: Document): string | null {
  // Try common article selectors
  const selectors = [
    'article',
    '[role="main"]',
    'main',
    '.post-content',
    '.article-content',
    '.entry-content',
    '.content',
    '#content',
    '.story-body',
    '.article-body',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent) {
      const text = cleanText(el.textContent);
      if (text.length > 200) {
        return text;
      }
    }
  }

  // Last resort: get body text
  const body = document.body;
  if (body) {
    // Remove scripts, styles, nav, footer, etc.
    const removeSelectors = ['script', 'style', 'nav', 'header', 'footer', 'aside', '.ad', '.ads'];
    removeSelectors.forEach(sel => {
      body.querySelectorAll(sel).forEach(el => el.remove());
    });

    const text = cleanText(body.textContent || '');
    if (text.length > 200) {
      return text;
    }
  }

  return null;
}

function cleanText(text: string): string {
  return text
    // Normalize whitespace
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    // Remove excessive spaces
    .replace(/ {2,}/g, ' ')
    // Trim each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function detectLanguage(text: string): string {
  // Simple heuristic for English detection
  const sample = text.toLowerCase().substring(0, 1000);
  const englishWords = ['the', 'is', 'and', 'of', 'to', 'in', 'a', 'that', 'it', 'for'];
  const words = sample.split(/\s+/);
  const englishCount = words.filter(w => englishWords.includes(w)).length;
  const englishRatio = englishCount / Math.max(1, words.length);

  return englishRatio > 0.05 ? 'en' : 'unknown';
}
