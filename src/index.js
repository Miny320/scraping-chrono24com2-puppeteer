const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config.json');


puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const CONFIG = {
    PARENT_URL: config.PARENT_URL,
    CHECK_INTERVAL: config.CHECK_INTERVAL, // 24 hours
};

let monitorState = {
    browser: null,
    page: null,
    cookies: null, // Store cookies for HTTP requests
};

const initBrowser = async () => {
    console.log('Starting Chrono24.com Monitor (with pagination)...');
    monitorState.browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=VizDisplayCompositor',
            '--disable-web-security',
            '--disable-features=site-per-process',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--disable-gpu'
        ]
    });
    monitorState.page = await monitorState.browser.newPage();

    await monitorState.page.setViewport({ width: 1366, height: 768 });

    await monitorState.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await monitorState.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
    });

    await monitorState.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });
    });

    console.log('Browser initialized with stealth mode');
}

// Get cookies from browser and format them for HTTP requests
const getCookiesFromBrowser = async () => {
    if (!monitorState.page) {
        throw new Error('Browser page not initialized');
    }
    
    try {
        // Navigate to the parent URL to get cookies
        await monitorState.page.goto(CONFIG.PARENT_URL, {
            waitUntil: 'networkidle2',
            timeout: 90000
        });
        
        // Wait for page to fully load and any JavaScript to set cookies
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Wait for Cloudflare challenge if present
        let cloudflareCheckCount = 0;
        const maxCloudflareChecks = 10;
        
        while (cloudflareCheckCount < maxCloudflareChecks) {
            const isCloudflareChallenge = await monitorState.page.evaluate(() => {
                return document.title.includes('Just a moment') ||
                    document.querySelector('cf-challenge') !== null ||
                    document.querySelector('.cf-browser-verification') !== null ||
                    document.querySelector('#challenge-form') !== null;
            });

            if (isCloudflareChallenge) {
                console.log(`Waiting for page to load... (${cloudflareCheckCount + 1}/${maxCloudflareChecks})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                cloudflareCheckCount++;
            } else {
                break;
            }
        }
        
        // Wait a bit more for all cookies to be set (especially JavaScript-set cookies)
        // Some cookies are set after page load by JavaScript
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Get ALL cookies from the page - this gets all cookies for the current domain
        const cookies = await monitorState.page.cookies();
        
        // Debug: log cookie names and details
        console.log(`Retrieved ${cookies.length} cookies:`, cookies.map(c => c.name).join(', '));
        
        // Log cookie details for debugging
        cookies.forEach(cookie => {
            console.log(`  - ${cookie.name}: domain=${cookie.domain}, path=${cookie.path}, httpOnly=${cookie.httpOnly}, secure=${cookie.secure}`);
        });
        
        // Format cookies as a cookie string (exactly as browser sends them)
        // Note: Browser sends cookies in a specific order, but we'll use alphabetical for consistency
        const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        
        monitorState.cookies = cookieString;
        console.log(`✅ Cookie string length: ${cookieString.length} characters`);
        
        if (cookieString.length < 100) {
            console.log('⚠️  Cookie string seems very short, might be missing cookies');
        }
        
        return cookieString;
    } catch (error) {
        console.error('Error getting cookies from browser:', error.message);
        throw error;
    }
}

// Fetch HTML content via HTTP request using Puppeteer's CDP (to use browser's network stack)
const fetchPageHtml = async (url, refererUrl = null) => {
    try {
        console.log(`Fetching page via HTTP (using browser network): ${url}`);
        
        if (!monitorState.page) {
            throw new Error('Browser page not initialized');
        }
        
        // Calculate referer: if showpage parameter exists, use previous page; otherwise use the same URL
        let referer = refererUrl || url;
        if (url.includes('showpage')) {
            const pageMatch = url.match(/showpage=(\d+)/);
            if (pageMatch) {
                const currentPage = parseInt(pageMatch[1]);
                if (currentPage > 1) {
                    referer = url.replace(/showpage=\d+/, `showpage=${currentPage - 1}`);
                } else {
                    referer = url.replace(/[?&]showpage=\d+/, '');
                }
            }
        }
        
        // Use browser's fetch API which automatically uses cookies and browser's network stack
        const html = await monitorState.page.evaluate(async (url, referer) => {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': referer,
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                },
                credentials: 'include' // Include cookies automatically
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.text();
        }, url, referer);
        
        console.log(`Response status: 200 OK`);
        console.log(`Response content length: ${html.length} characters`);
        
        return html;
    } catch (error) {
        console.error(`Error fetching page ${url}:`, error.message);
        throw error;
    }
}

// Extract watch URLs from HTML content
const extractWatchUrlsFromHtml = (html, baseUrl) => {
    const $ = cheerio.load(html);
    const watchUrls = [];
    
    // Method 1: Try to extract URLs from JSON-LD structured data (most reliable)
    try {
        const jsonLdScripts = $('script[type="application/ld+json"]');
        const scriptCount = jsonLdScripts.length;
        console.log(`Found ${scriptCount} JSON-LD script tag(s)`);
        
        if (scriptCount === 0) {
            console.log('No JSON-LD script tags found, will try DOM parsing');
        }
        
        jsonLdScripts.each((index, script) => {
            try {
                const scriptContent = $(script).html();
                if (scriptContent) {
                    const jsonData = JSON.parse(scriptContent);
                    
                    // Handle both single object and @graph array
                    const graph = jsonData['@graph'] || (Array.isArray(jsonData) ? jsonData : [jsonData]);
                    console.log(`Processing JSON-LD graph with ${graph.length} item(s)`);
                    
                    graph.forEach((item) => {
                        if (item['@type'] === 'AggregateOffer' && item.offers && Array.isArray(item.offers)) {
                            console.log(`Found AggregateOffer with ${item.offers.length} offer(s)`);
                            item.offers.forEach((offer) => {
                                if (offer['@type'] === 'Offer' && offer.url) {
                                    let url = offer.url;
                                    // Normalize URL (remove fragments and query params if needed)
                                    url = url.split('#')[0];
                                    // Only add if it's a watch detail page (contains .htm) and not already in list
                                    if (url.includes('.htm') && !watchUrls.includes(url)) {
                                        watchUrls.push(url);
                                    }
                                }
                            });
                        }
                    });
                }
            } catch (parseError) {
                // Skip invalid JSON, continue to next script tag
                console.log(`Error parsing JSON-LD script ${index + 1}:`, parseError.message);
            }
        });
        
        if (watchUrls.length > 0) {
            console.log(`✅ Extracted ${watchUrls.length} URLs from JSON-LD structured data`);
            return watchUrls;
        } else {
            console.log('No URLs found in JSON-LD data');
        }
    } catch (error) {
        console.log('Error extracting from JSON-LD, falling back to DOM parsing:', error.message);
    }
    
    // Method 2: Fall back to DOM parsing if JSON-LD extraction didn't work
    console.log('Falling back to DOM parsing for watch URLs...');
    
    // Find all article item containers
    const articleItems = $('.article-item-container, .js-article-item-container');
    console.log(`Found ${articleItems.length} article item container(s)`);
    
    articleItems.each((index, item) => {
        try {
            const $item = $(item);
            let linkElement = null;
            
            // Try multiple selectors to find the watch link
            linkElement = $item.find('a.wt-listing-item-link, a.listing-item-link').first();
            
            // If not found, try any anchor with href containing .htm
            if (linkElement.length === 0) {
                linkElement = $item.find('a[href*=".htm"]').first();
            }
            
            // If still not found, try any anchor with href
            if (linkElement.length === 0) {
                $item.find('a[href]').each((i, link) => {
                    const href = $(link).attr('href');
                    if (href && !href.startsWith('#') && href.includes('.htm')) {
                        linkElement = $(link);
                        return false; // break
                    }
                });
            }
            
            if (linkElement.length > 0) {
                let href = linkElement.attr('href');
                if (href) {
                    // Ensure full URL
                    if (!href.startsWith('http')) {
                        if (href.startsWith('index.htm')) {
                            href = 'https://www.chrono24.com/search/' + href;
                        } else if (href.startsWith('/')) {
                            href = 'https://www.chrono24.com' + href;
                        } else {
                            const urlObj = new URL(baseUrl);
                            const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                            href = urlObj.origin + basePath + '/' + href;
                        }
                    }
                    // Normalize URL (remove fragments)
                    href = href.split('#')[0];
                    // Only add if it's a watch detail page (contains .htm) and not already in list
                    if (href.includes('.htm') && !watchUrls.includes(href)) {
                        watchUrls.push(href);
                    }
                }
            }
        } catch (error) {
            console.log('Error processing item:', error);
        }
    });
    
    return watchUrls;
}

// Check if there's a next page available from HTML
const hasNextPageFromHtml = (html, currentUrl) => {
    try {
        const $ = cheerio.load(html);
        
        // Extract current page number from URL
        const currentUrlObj = new URL(currentUrl);
        const currentPageParam = currentUrlObj.searchParams.get('showpage');
        const currentPageNum = currentPageParam ? parseInt(currentPageParam) : 1;
        
        // Look for the pagination list
        let pagination = $('ul.list-unstyled.d-flex.gap-1').first();
        if (pagination.length === 0) {
            pagination = $('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]').first();
        }
        
        if (pagination.length === 0) {
            return { hasNext: false, nextUrl: null, nextPageNum: null };
        }
        
        // Find the forward/next button with i-forward icon
        const forwardButton = pagination.find('a i.i-forward').parent('a');
        if (forwardButton.length > 0) {
            const href = forwardButton.attr('href');
            const isDisabled = forwardButton.hasClass('disabled');
            
            if (href && !isDisabled) {
                let nextUrl = href;
                // Handle relative URLs
                if (!nextUrl.startsWith('http')) {
                    if (nextUrl.startsWith('index.htm')) {
                        nextUrl = 'https://www.chrono24.com/search/' + nextUrl;
                    } else if (nextUrl.startsWith('/')) {
                        nextUrl = 'https://www.chrono24.com' + nextUrl;
                    } else {
                        const urlObj = new URL(currentUrl);
                        const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                        nextUrl = urlObj.origin + basePath + '/' + nextUrl;
                    }
                }
                
                // Extract page number from next URL
                const nextUrlObj = new URL(nextUrl);
                const nextPageParam = nextUrlObj.searchParams.get('showpage');
                const nextPageNum = nextPageParam ? parseInt(nextPageParam) : (currentPageNum + 1);
                
                if (nextPageNum > currentPageNum) {
                    return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
                }
            }
        }
        
        // Check for page number links that have showpage parameter
        let nextPageNum = null;
        let nextUrl = null;
        
        pagination.find('a[href*="showpage"]').each((i, link) => {
            const $link = $(link);
            if (!$link.hasClass('disabled')) {
                let linkUrl = $link.attr('href');
                if (linkUrl) {
                    // Handle relative URLs
                    if (!linkUrl.startsWith('http')) {
                        if (linkUrl.startsWith('index.htm')) {
                            linkUrl = 'https://www.chrono24.com/search/' + linkUrl;
                        } else if (linkUrl.startsWith('/')) {
                            linkUrl = 'https://www.chrono24.com' + linkUrl;
                        }
                    }
                    
                    try {
                        const linkUrlObj = new URL(linkUrl);
                        const linkPageParam = linkUrlObj.searchParams.get('showpage');
                        const linkPageNum = linkPageParam ? parseInt(linkPageParam) : null;
                        
                        if (linkPageNum && linkPageNum > currentPageNum) {
                            if (!nextPageNum || linkPageNum < nextPageNum) {
                                nextPageNum = linkPageNum;
                                nextUrl = linkUrl;
                            }
                        }
                    } catch (e) {
                        // Skip invalid URLs
                    }
                }
            }
        });
        
        if (nextUrl && nextPageNum && nextPageNum > currentPageNum) {
            return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
        }
        
        return { hasNext: false, nextUrl: null, nextPageNum: null };
    } catch (error) {
        console.log('Error checking for next page from HTML:', error.message);
        return { hasNext: false, nextUrl: null, nextPageNum: null };
    }
}

// Check if there's a next page available (using Puppeteer - kept for backward compatibility)
const hasNextPage = async (currentUrl) => {
    try {
        const nextPageInfo = await monitorState.page.evaluate((currentUrl) => {
            // Extract current page number from URL
            const currentUrlObj = new URL(currentUrl);
            const currentPageParam = currentUrlObj.searchParams.get('showpage');
            const currentPageNum = currentPageParam ? parseInt(currentPageParam) : 1;

            // Look for the pagination list
            const paginationList = document.querySelector('ul.list-unstyled.d-flex.gap-1');
            if (!paginationList) {
                // Try alternative selector
                const altPagination = document.querySelector('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]');
                if (!altPagination) return { hasNext: false, nextUrl: null, nextPageNum: null };
            }

            const pagination = paginationList || document.querySelector('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]');
            if (!pagination) return { hasNext: false, nextUrl: null, nextPageNum: null };

            // Find the forward/next button with i-forward icon
            const forwardButton = pagination.querySelector('a i.i-forward')?.closest('a');
            if (forwardButton && forwardButton.href && !forwardButton.classList.contains('disabled')) {
                let nextUrl = forwardButton.href;
                // Handle relative URLs
                if (nextUrl && !nextUrl.startsWith('http')) {
                    if (nextUrl.startsWith('index.htm')) {
                        nextUrl = window.location.origin + '/search/' + nextUrl;
                    } else if (nextUrl.startsWith('/')) {
                        nextUrl = window.location.origin + nextUrl;
                    } else {
                        const currentPath = window.location.pathname;
                        const basePath = currentPath.substring(0, currentPath.lastIndexOf('/'));
                        nextUrl = window.location.origin + basePath + '/' + nextUrl;
                    }
                }
                // Extract page number from next URL
                const nextUrlObj = new URL(nextUrl);
                const nextPageParam = nextUrlObj.searchParams.get('showpage');
                const nextPageNum = nextPageParam ? parseInt(nextPageParam) : (currentPageNum + 1);
                
                if (nextPageNum > currentPageNum) {
                    return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
                }
            }

            // Check for page number links that have showpage parameter
            const pageLinks = pagination.querySelectorAll('a[href*="showpage"]');
            let nextPageNum = null;
            let nextUrl = null;
            
            for (const link of pageLinks) {
                if (!link.classList.contains('disabled') && link.href) {
                    let linkUrl = link.href;
                    // Handle relative URLs
                    if (linkUrl && !linkUrl.startsWith('http')) {
                        if (linkUrl.startsWith('index.htm')) {
                            linkUrl = window.location.origin + '/search/' + linkUrl;
                        } else if (linkUrl.startsWith('/')) {
                            linkUrl = window.location.origin + linkUrl;
                        }
                    }
                    
                    try {
                        const linkUrlObj = new URL(linkUrl);
                        const linkPageParam = linkUrlObj.searchParams.get('showpage');
                        const linkPageNum = linkPageParam ? parseInt(linkPageParam) : null;
                        
                        if (linkPageNum && linkPageNum > currentPageNum) {
                            if (!nextPageNum || linkPageNum < nextPageNum) {
                                nextPageNum = linkPageNum;
                                nextUrl = linkUrl;
                            }
                        }
                    } catch (e) {
                        // Skip invalid URLs
                        continue;
                    }
                }
            }

            if (nextUrl && nextPageNum && nextPageNum > currentPageNum) {
                return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
            }

            return { hasNext: false, nextUrl: null, nextPageNum: null };
        }, currentUrl);

        return nextPageInfo;
    } catch (error) {
        console.log('Error checking for next page:', error.message);
        return { hasNext: false, nextUrl: null, nextPageNum: null };
    }
}

// Scrape watch URLs from a single page
const scrapeSinglePage = async () => {
    console.log(`Scraping page: ${monitorState.page.url()}`);

    try {
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Wait for Cloudflare challenge to complete
        let cloudflareCheckCount = 0;
        const maxCloudflareChecks = 10;
        
        while (cloudflareCheckCount < maxCloudflareChecks) {
            const isCloudflareChallenge = await monitorState.page.evaluate(() => {
                return document.title.includes('Just a moment') ||
                    document.querySelector('cf-challenge') !== null ||
                    document.querySelector('.cf-browser-verification') !== null ||
                    document.querySelector('#challenge-form') !== null;
            });

            if (isCloudflareChallenge) {
                console.log(`Cloudflare challenge detected, waiting... (${cloudflareCheckCount + 1}/${maxCloudflareChecks})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                cloudflareCheckCount++;
            } else {
                break;
            }
        }

        if (cloudflareCheckCount >= maxCloudflareChecks) {
            console.log('⚠️  Cloudflare challenge may still be active, continuing anyway...');
        }

        await monitorState.page.waitForSelector('.article-item-container, .js-article-item-container', { timeout: 60000 });

        // Extract only watch URLs from the page
        const watchUrls = await monitorState.page.evaluate(() => {
            const items = document.querySelectorAll('.article-item-container, .js-article-item-container');
            const urls = [];

            items.forEach((item) => {
                try {
                    // Try multiple selectors to find the watch link
                    // First try the listing item link
                    let linkElement = item.querySelector('a.wt-listing-item-link, a.listing-item-link');
                    
                    // If not found, try any anchor with href containing .htm (watch detail pages)
                    if (!linkElement) {
                        linkElement = item.querySelector('a[href*=".htm"]');
                    }
                    
                    // If still not found, try any anchor with href
                    if (!linkElement) {
                        const allLinks = item.querySelectorAll('a[href]');
                        for (const link of allLinks) {
                            const href = link.getAttribute('href');
                            // Skip hash links, empty links, or non-watch links
                            if (href && !href.startsWith('#') && href.includes('.htm')) {
                                linkElement = link;
                                break;
                            }
                        }
                    }
                    
                    if (linkElement && linkElement.href) {
                        const link = linkElement.href;
                        // Ensure full URL
                        let fullUrl = link.startsWith('http') ? link : window.location.origin + link;
                        // Normalize URL (remove fragments)
                        fullUrl = fullUrl.split('#')[0];
                        // Only add if it's a watch detail page (contains .htm)
                        if (fullUrl.includes('.htm') && !urls.includes(fullUrl)) {
                            urls.push(fullUrl);
                        }
                    }
                } catch (error) {
                    console.log('Error processing item:', error);
                }
            });

            return urls;
        });

        console.log(`Found ${watchUrls.length} watch URLs on this page`);
        if (watchUrls.length > 0) {
            console.log('Sample URLs:', watchUrls.slice(0, 3).map(url => url.substring(0, 80) + '...'));
        }
        return watchUrls;

    } catch (error) {
        console.error('Error scraping page:', error.message);
        return [];
    }
}

// Scrape all pages with pagination support using browser (fallback when HTTP fails)
const scrapeWatchListingsWithBrowser = async () => {
    console.log('Scraping watch listings with pagination support (using browser)...');

    // Initialize browser if not already initialized
    if (!monitorState.browser || !monitorState.page) {
        console.log('Initializing browser for listing page scraping...');
        await initBrowser();
    }

    let allWatchUrls = [];
    let visitedUrls = new Set();
    const maxPages = 20;

    try {
        await monitorState.page.goto(CONFIG.PARENT_URL, {
            waitUntil: 'networkidle2',
            timeout: 90000
        });

        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check and wait for Cloudflare challenge
        let cloudflareCheckCount = 0;
        const maxCloudflareChecks = 10;
        
        while (cloudflareCheckCount < maxCloudflareChecks) {
            const isCloudflareChallenge = await monitorState.page.evaluate(() => {
                return document.title.includes('Just a moment') ||
                    document.querySelector('cf-challenge') !== null ||
                    document.querySelector('.cf-browser-verification') !== null ||
                    document.querySelector('#challenge-form') !== null;
            });

            if (isCloudflareChallenge) {
                console.log(`Cloudflare challenge detected, waiting... (${cloudflareCheckCount + 1}/${maxCloudflareChecks})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                cloudflareCheckCount++;
            } else {
                break;
            }
        }

        let currentPage = 1;
        let hasMorePages = true;
        let currentUrl = monitorState.page.url();

        while (hasMorePages && currentPage <= maxPages) {
            console.log(`\nProcessing page ${currentPage}...`);
            
            if (visitedUrls.has(currentUrl)) {
                console.log(`⚠️  Already visited this URL, stopping pagination.`);
                break;
            }
            visitedUrls.add(currentUrl);
            
            let nextPageInfo = null;
            try {
                const pageWatchUrls = await scrapeSinglePage();
                if (pageWatchUrls && pageWatchUrls.length > 0) {
                    pageWatchUrls.forEach(url => {
                        if (!allWatchUrls.includes(url)) {
                            allWatchUrls.push(url);
                        }
                    });
                    console.log(`✅ Found ${pageWatchUrls.length} watch URLs on this page (${allWatchUrls.length} total unique URLs)`);
                }

                nextPageInfo = await hasNextPage(currentUrl);
                
                if (nextPageInfo.hasNext && nextPageInfo.nextUrl && nextPageInfo.nextPageNum) {
                    if (visitedUrls.has(nextPageInfo.nextUrl)) {
                        console.log(`⚠️  Next page URL already visited, stopping pagination.`);
                        hasMorePages = false;
                        break;
                    }
                    
                    console.log(`Next page found: Page ${nextPageInfo.nextPageNum} - ${nextPageInfo.nextUrl}`);
                    
                    await monitorState.page.goto(nextPageInfo.nextUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 90000
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    currentUrl = monitorState.page.url();
                    currentPage++;
                } else {
                    hasMorePages = false;
                    console.log('No more pages to scrape.');
                }
            } catch (pageError) {
                console.error(`Error scraping page ${currentPage}: ${pageError.message}`);
                hasMorePages = false;
                break;
            }
        }

        allWatchUrls = [...new Set(allWatchUrls)];
        console.log(`\n✅ Total watch URLs found across ${currentPage} pages: ${allWatchUrls.length}`);
        return allWatchUrls;

    } catch (error) {
        console.error('Error scraping listings with browser:', error.message);
        allWatchUrls = [...new Set(allWatchUrls)];
        return allWatchUrls;
    }
}

// Scrape all pages with pagination support using HTTP requests (with browser fallback)
const scrapeWatchListings = async () => {
    console.log('Scraping watch listings with pagination support (trying HTTP requests first)...');

    let allWatchUrls = [];
    let visitedUrls = new Set();
    const maxPages = 20; // Safety limit to prevent infinite loops (127 watches should be ~3 pages)

    try {
        let currentPage = 1;
        let hasMorePages = true;
        let currentUrl = CONFIG.PARENT_URL;
        let previousUrl = null;
        let cloudflareDetected = false;

        while (hasMorePages && currentPage <= maxPages) {
            console.log(`\nProcessing page ${currentPage}...`);
            console.log(`URL: ${currentUrl}`);
            
            // Check if we've already visited this URL
            if (visitedUrls.has(currentUrl)) {
                console.log(`⚠️  Already visited this URL, stopping pagination to prevent loop.`);
                break;
            }
            visitedUrls.add(currentUrl);
            
            let nextPageInfo = null;
            try {
                // Fetch page HTML via HTTP request (pass previous URL as referer)
                const html = await fetchPageHtml(currentUrl, previousUrl);
                
                // Extract watch URLs from HTML
                const pageWatchUrls = extractWatchUrlsFromHtml(html, currentUrl);
                
                if (pageWatchUrls && pageWatchUrls.length > 0) {
                    // Deduplicate URLs before adding
                    pageWatchUrls.forEach(url => {
                        if (!allWatchUrls.includes(url)) {
                            allWatchUrls.push(url);
                        }
                    });
                    console.log(`✅ Found ${pageWatchUrls.length} watch URLs on this page (${allWatchUrls.length} total unique URLs)`);
                } else {
                    console.log(`⚠️  No watch URLs found on page ${currentPage}`);
                }

                // Check if there's a next page from HTML
                nextPageInfo = hasNextPageFromHtml(html, currentUrl);
                
                if (nextPageInfo.hasNext && nextPageInfo.nextUrl && nextPageInfo.nextPageNum) {
                    // Check if we've already visited the next URL
                    if (visitedUrls.has(nextPageInfo.nextUrl)) {
                        console.log(`⚠️  Next page URL already visited, stopping pagination.`);
                        hasMorePages = false;
                        break;
                    }
                    
                    console.log(`Next page found: Page ${nextPageInfo.nextPageNum} - ${nextPageInfo.nextUrl}`);
                    previousUrl = currentUrl;
                    currentUrl = nextPageInfo.nextUrl;
                    currentPage++;
                    
                    // Small delay between requests to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    hasMorePages = false;
                    console.log('No more pages to scrape.');
                }
            } catch (pageError) {
                console.error(`Error scraping page ${currentPage}: ${pageError.message}`);
                
                // If 403 Forbidden (cookies expired), try to refresh cookies and retry once
                if (pageError.message.includes('403 Forbidden') || pageError.message.includes('refresh cookies')) {
                    console.log('⚠️  Cookies may have expired, refreshing cookies and retrying...');
                    try {
                        await getCookiesFromBrowser();
                        // Retry the same page once
                        const html = await fetchPageHtml(currentUrl, previousUrl);
                        const pageWatchUrls = extractWatchUrlsFromHtml(html, currentUrl);
                        if (pageWatchUrls && pageWatchUrls.length > 0) {
                            pageWatchUrls.forEach(url => {
                                if (!allWatchUrls.includes(url)) {
                                    allWatchUrls.push(url);
                                }
                            });
                            console.log(`✅ Found ${pageWatchUrls.length} watch URLs after refreshing cookies`);
                        }
                        nextPageInfo = hasNextPageFromHtml(html, currentUrl);
                        // Continue with pagination
                        if (nextPageInfo.hasNext && nextPageInfo.nextUrl && nextPageInfo.nextPageNum) {
                            if (!visitedUrls.has(nextPageInfo.nextUrl)) {
                                previousUrl = currentUrl;
                                currentUrl = nextPageInfo.nextUrl;
                                currentPage++;
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                continue;
                            }
                        }
                    } catch (retryError) {
                        console.log('⚠️  Retry failed, switching to browser-based scraping...');
                        cloudflareDetected = true;
                        break;
                    }
                }
                
                // If other errors, try to continue to next page if we have pagination info
                if (nextPageInfo && nextPageInfo.hasNext && nextPageInfo.nextUrl && !visitedUrls.has(nextPageInfo.nextUrl)) {
                    previousUrl = currentUrl;
                    currentUrl = nextPageInfo.nextUrl;
                    currentPage++;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    hasMorePages = false;
                    break;
                }
            }
        }

        // If HTTP requests failed, use browser fallback
        if (cloudflareDetected) {
            console.log('\n🔄 Falling back to browser-based scraping...');
            const browserUrls = await scrapeWatchListingsWithBrowser();
            // Merge with any URLs we already collected
            browserUrls.forEach(url => {
                if (!allWatchUrls.includes(url)) {
                    allWatchUrls.push(url);
                }
            });
        }

        if (currentPage > maxPages && !cloudflareDetected) {
            console.log(`⚠️  Reached maximum page limit (${maxPages}), stopping.`);
        }

        // Deduplicate final list
        allWatchUrls = [...new Set(allWatchUrls)];
        console.log(`\n✅ Total watch URLs found: ${allWatchUrls.length}`);
        return allWatchUrls;

    } catch (error) {
        console.error('Error scraping listings:', error.message);
        // If HTTP completely fails, try browser
        if (error.message.includes('403 Forbidden') || error.message.includes('refresh cookies')) {
            console.log('\n🔄 HTTP requests failed, falling back to browser-based scraping...');
            return await scrapeWatchListingsWithBrowser();
        }
        // Return collected URLs even if there was an error
        allWatchUrls = [...new Set(allWatchUrls)];
        console.log(`Returning ${allWatchUrls.length} collected URLs despite error.`);
        return allWatchUrls;
    }
}

// Fetch watch detail page HTML via HTTP request (using browser fetch)
const fetchWatchDetailHtml = async (watchUrl, refererUrl = null) => {
    try {
        console.log(`Fetching watch detail page via HTTP: ${watchUrl}`);
        
        if (!monitorState.page) {
            throw new Error('Browser page not initialized');
        }
        
        // Use search page as referer if not provided
        const referer = refererUrl || CONFIG.PARENT_URL;
        
        // Use browser's fetch API which automatically uses cookies and browser's network stack
        const html = await monitorState.page.evaluate(async (url, referer) => {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': referer,
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                },
                credentials: 'include' // Include cookies automatically
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.text();
        }, watchUrl, referer);
        
        console.log(`Response status: 200 OK`);
        
        return html;
    } catch (error) {
        console.error(`Error fetching watch detail page ${watchUrl}:`, error.message);
        throw error;
    }
}

// Helper function to clean and extract base model name
const cleanModelName = (modelString) => {
    if (!modelString || typeof modelString !== 'string') {
        return '';
    }
    
    // Remove leading/trailing whitespace
    let model = modelString.trim();
    
    // If model contains "|", take only the first part (before the first pipe)
    // Example: "Royal Oak Quartz | 56271ST | Blue Dial" -> "Royal Oak Quartz"
    if (model.includes('|')) {
        model = model.split('|')[0].trim();
    }
    
    // Remove reference numbers (patterns like "56271ST", "116619LB", "WSSA0030", etc.)
    // These are typically 5-6 digits followed by 1-3 letters, or alphanumeric codes
    model = model.replace(/\b\d{5,6}[A-Z]{1,3}\b/g, '').trim();
    model = model.replace(/\b[A-Z]{2,}\d{4,}\b/g, '').trim(); // Patterns like "WSSA0030"
    
    // Remove movement types that appear at the end (these are not part of model name)
    const movementTypes = ['Quartz', 'Automatic', 'Manual', 'Mechanical'];
    for (const movement of movementTypes) {
        const regex = new RegExp(`\\b${movement}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove dial colors that appear at the end
    const dialColors = [
        'Blue Dial', 'Black Dial', 'White Dial', 'Green Dial', 'Rhodium Dial',
        'Silver Dial', 'Grey Dial', 'Gray Dial', 'Pink Dial', 'Red Dial'
    ];
    for (const color of dialColors) {
        const regex = new RegExp(`\\b${color}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove condition descriptions at the end
    const conditions = [
        'Great Condition', 'Mint Condition', 'Very Good', 'Excellent',
        'Good Condition', 'Fair Condition', 'Unworn', 'New'
    ];
    for (const condition of conditions) {
        const regex = new RegExp(`\\b${condition}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove other descriptive words that shouldn't be part of model name
    const otherDescriptive = [
        'Box', 'Papers', 'Original', 'Certified', 'Pre-Owned',
        'With Box', 'With Papers', 'Box & Papers'
    ];
    for (const word of otherDescriptive) {
        const regex = new RegExp(`\\b${word}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove year patterns at the end (like "2025", "2024", etc.)
    model = model.replace(/\b(19|20)\d{2}\s*$/, '').trim();
    
    // Remove any remaining multiple spaces
    model = model.replace(/\s+/g, ' ').trim();
    
    return model;
};

// Extract watch details from HTML using cheerio
const extractWatchDetailsFromHtml = (html, watchUrl) => {
    const $ = cheerio.load(html);
    const result = {
        brand: '',
        model: '',
        referenceNumber: '',
        year: null,
        condition: 'unworn', // Default: unworn if not found
        gender: '',
        location: '',
        price: 0,
        currency: 'USD',
        originalBox: false,
        originalPaper: false,
        images: [],
        watchUrl: watchUrl
    };

    // Method 1: Try to extract from JSON-LD structured data (most reliable)
    try {
        const jsonLdScripts = $('script[type="application/ld+json"]');
        
        jsonLdScripts.each((index, script) => {
            try {
                const scriptContent = $(script).html();
                if (scriptContent) {
                    const jsonData = JSON.parse(scriptContent);
                    
                    // Handle both single object and @graph array
                    const graph = jsonData['@graph'] || (Array.isArray(jsonData) ? jsonData : [jsonData]);
                    
                    graph.forEach((item) => {
                        if (item['@type'] === 'Product') {
                            // Extract images from JSON-LD
                            if (item.image && Array.isArray(item.image)) {
                                item.image.forEach((imgObj) => {
                                    if (imgObj['@type'] === 'ImageObject' && imgObj.contentUrl) {
                                        // Normalize image URL - convert ExtraLarge to Square420
                                        let imgUrl = imgObj.contentUrl;
                                        // Replace ExtraLarge.jpg with Square420.jpg for consistency
                                        imgUrl = imgUrl.replace(/ExtraLarge\.(jpg|jpeg|png|webp)$/i, 'Square420.$1');
                                        // If no extension, add .jpg
                                        if (!/\.(jpg|jpeg|png|webp)$/i.test(imgUrl)) {
                                            imgUrl = imgUrl + '.jpg';
                                        }
                                        if (imgUrl && !result.images.includes(imgUrl)) {
                                            result.images.push(imgUrl);
                                        }
                                    }
                                });
                            }
                            
                            // Extract offer details (price, currency) from JSON-LD
                            if (item.offers && item.offers['@type'] === 'Offer') {
                                const offer = item.offers;
                                
                                // Extract price
                                if (offer.price) {
                                    result.price = typeof offer.price === 'string' 
                                        ? parseInt(offer.price.replace(/,/g, '')) 
                                        : parseInt(offer.price);
                                }
                                
                                // Extract currency
                                if (offer.priceCurrency) {
                                    result.currency = offer.priceCurrency;
                                }
                            }
                            
                            // Extract box and papers from description or name
                            if (item.description) {
                                const descLower = item.description.toLowerCase();
                                result.originalBox = descLower.includes('original box') || descLower.includes('box');
                                result.originalPaper = descLower.includes('original paper') || 
                                                      descLower.includes('paper') ||
                                                      descLower.includes('certificate') ||
                                                      descLower.includes('card');
                            }
                            
                            // Also check name for box/paper info
                            if (item.name) {
                                const nameLower = item.name.toLowerCase();
                                if (nameLower.includes('box')) {
                                    result.originalBox = true;
                                }
                                if (nameLower.includes('paper')) {
                                    result.originalPaper = true;
                                }
                            }
                        }
                    });
                }
            } catch (parseError) {
                // Skip invalid JSON, continue to next script tag
            }
        });
        
        // JSON-LD extraction complete - only extracted: images, price, currency, originalBox, originalPaper
        // Continue to HTML parsing to extract: brand, model, reference, year, condition, location, gender
    } catch (error) {
        // Silent fallback to HTML parsing
    }
    
    // Method 2: HTML table parsing - always run to extract/replace data from HTML structure

    // Images are extracted from JSON-LD only (not from HTML)
    
    // Extract details from HTML table structure
    // Find the first div with class "js-tab-panel tab-panel" (contains all the data)
    const tabPanels = $('.js-tab-panel.tab-panel');
    let tabPanel = tabPanels.first();
    
    if (tabPanel.length > 0) {
        // Find the first table in the tab panel (contains Basic Info section)
        const firstTable = tabPanel.find('table').first();
        
        if (firstTable.length > 0) {
            // Process all tbody sections in the table
            firstTable.find('tbody').each((tbodyIndex, tbody) => {
                const $tbody = $(tbody);
                
                // Find all rows in this tbody
                $tbody.find('tr').each((index, row) => {
                    const $row = $(row);
                    const cells = $row.find('td');
                    
                    // Skip if not enough cells (need at least 2 for label and value)
                    if (cells.length < 2) {
                        return;
                    }
                    
                    // Get label from first cell (should be in <strong> tag)
                    const $labelCell = cells.eq(0);
                    let label = $labelCell.find('strong').first().text().trim();
                    if (!label) {
                        label = $labelCell.text().trim();
                    }
                    
                    // Skip header rows (those with colspan="2" or containing only headers)
                    if ($labelCell.attr('colspan') === '2' || cells.length === 1) {
                        return;
                    }
                    
                    // Skip if label is empty
                    if (!label) {
                        return;
                    }
                    
                    label = label.toLowerCase();
                    
                    // Skip section headers (Basic Info, Caliber, Case, Bracelet, Description, etc.)
                    if (label.includes('basic info') || label.includes('caliber') || 
                        label.includes('case') || label.includes('bracelet') || 
                        label.includes('functions') || label.includes('description')) {
                        return;
                    }
                    
                    // Get value from second cell
                    const $valueCell = cells.eq(1);
                    let value = $valueCell.text().trim();
                    
                    // Extract specific fields based on label
                    if (label.includes('brand')) {
                        // Brand is usually in an <a> tag
                        const brandLink = $valueCell.find('a').first();
                        if (brandLink.length > 0) {
                            result.brand = brandLink.text().trim();
                        } else if (value) {
                            result.brand = value;
                        }
                    } else if (label.includes('model')) {
                        // Model is usually in an <a> tag
                        const modelLink = $valueCell.find('a').first();
                        let modelValue = '';
                        if (modelLink.length > 0) {
                            modelValue = modelLink.text().trim();
                        } else if (value) {
                            modelValue = value;
                        }
                        if (modelValue) {
                            result.model = cleanModelName(modelValue);
                        }
                    } else if (label.includes('reference number') || label.includes('reference')) {
                        // Reference number is usually in an <a> tag
                        const refLink = $valueCell.find('a').first();
                        if (refLink.length > 0) {
                            result.referenceNumber = refLink.text().trim();
                        } else if (value) {
                            result.referenceNumber = value;
                        }
                    } else if (label.includes('year of production') || label.includes('year')) {
                        if (value && value.toLowerCase() !== 'unknown') {
                            const year = parseInt(value);
                            if (!isNaN(year)) {
                                result.year = year;
                            }
                        }
                    } else if (label.includes('condition')) {
                        // Condition might be in a button or just text
                        const conditionButton = $valueCell.find('button').first();
                        let conditionText = '';
                        if (conditionButton.length > 0) {
                            conditionText = conditionButton.text().trim();
                        } else if (value) {
                            conditionText = value;
                        }
                        if (conditionText) {
                            const conditionLower = conditionText.toLowerCase();
                            if (conditionLower.includes('used') || conditionLower.includes('very good') || 
                                conditionLower.includes('fine') || conditionLower.includes('fair') || 
                                conditionLower.includes('scrap') || conditionLower.includes('worn')) {
                                result.condition = 'worn';
                            } else if (conditionLower.includes('unworn') || conditionLower.includes('new')) {
                                result.condition = 'unworn';
                            }
                        }
                    } else if (label.includes('gender')) {
                        result.gender = value;
                    } else if (label.includes('location')) {
                        result.location = value;
                    }
                    // Note: price, currency, originalBox, originalPaper are extracted from JSON-LD only
                    // Note: images are extracted from JSON-LD only
                });
            });
        }
    }

    return result;
}

// Scrape watch details using HTTP requests with retry logic
const scrapeWatchDetails = async (watchUrl, retryCount = 0, maxRetries = 3) => {
    console.log(`Scraping details for: ${watchUrl}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);

    try {
        // Fetch HTML via HTTP request (using browser fetch)
        const html = await fetchWatchDetailHtml(watchUrl);
        
        // Extract details from HTML using cheerio
        const details = extractWatchDetailsFromHtml(html, watchUrl);

        // Validate that we got at least some data
        if (!details || (!details.brand && !details.model && !details.referenceNumber)) {
            throw new Error('Insufficient data extracted from page');
        }

        // Log extracted data
        console.log('--- Extracted Watch Details ---');
        console.log(`Brand: ${details.brand || 'N/A'}`);
        console.log(`Model: ${details.model || 'N/A'}`);
        console.log(`Reference: ${details.referenceNumber || 'N/A'}`);
        console.log(`Price: ${details.currency} ${details.price || 'N/A'}`);
        console.log(`Condition: ${details.condition || 'N/A'}`);
        console.log(`Location: ${details.location || 'N/A'}`);
        console.log(`Images found: ${details.images.length}`);
        if (details.images.length > 0) {
            console.log(`✅ First image: ${details.images[0].substring(0, 80)}...`);
            if (details.images.length > 1) {
                console.log(`   ... and ${details.images.length - 1} more image(s)`);
            }
        } else {
            console.log(`⚠️  No images found for this watch`);
        }
        console.log(`Original Box: ${details.originalBox ? 'Yes' : 'No'}`);
        console.log(`Original Paper: ${details.originalPaper ? 'Yes' : 'No'}`);
        console.log('--- End Watch Details ---\n');

        return details;
    } catch (error) {
        console.error(`Error scraping watch details${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}: ${error.message}`);
        
        // Retry logic with exponential backoff
        if (retryCount < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 seconds
            console.log(`⏳ Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return scrapeWatchDetails(watchUrl, retryCount + 1, maxRetries);
        }
        
        console.error(`❌ Failed to scrape after ${maxRetries} retries: ${watchUrl}`);
        return null;
    }
}

// REMOVED: scrapeWatchDetailsOld - unused function (~500 lines) removed to reduce code size

// Close browser and cleanup
const closeBrowser = async () => {
    if (monitorState.browser) {
        await monitorState.browser.close();
        console.log('Browser closed');
    }
}

const scrapeWatchData = async () => {
    try {
        // Step 0: Initialize browser and get cookies for HTTP requests
        console.log('\n========================================');
        console.log('Step 0: Initializing browser to get cookies...');
        console.log('========================================\n');
        await initBrowser();
        await getCookiesFromBrowser();
        console.log('✅ Cookies retrieved, can now use HTTP requests\n');

        // Step 1: Collect all watch URLs from all pages (using HTTP requests with cookies)
        console.log('========================================');
        console.log('Step 1: Collecting watch URLs from all pages (using HTTP requests with cookies)...');
        console.log('========================================\n');
        const watchUrls = await scrapeWatchListings();
        console.log(`\n✅ Found ${watchUrls.length} total watch URLs across all pages\n`);
        if (watchUrls.length > 0) {
            console.log('First 5 URLs:');
            watchUrls.slice(0, 5).forEach((url, idx) => {
                console.log(`  ${idx + 1}. ${url}`);
            });
            console.log('');
        }

        // Only continue if we found watch URLs
        if (watchUrls.length === 0) {
            console.log('No watch URLs found, skipping detail scraping.');
            return [];
        }

        // Step 2: Scrape details for each watch URL
        console.log('========================================');
        console.log('Step 2: Scraping details for each watch...');
        console.log('========================================\n');
        
        const watchDataPath = path.join(__dirname, '..', 'watchData.json');
        let watchData = [];
        
        // Load existing data if file exists (for resume capability)
        try {
            if (fs.existsSync(watchDataPath)) {
                const existingData = fs.readFileSync(watchDataPath, 'utf8');
                watchData = JSON.parse(existingData);
                console.log(`📂 Loaded ${watchData.length} existing watch(es) from watchData.json`);
            }
        } catch (error) {
            console.log('⚠️  Could not load existing watchData.json, starting fresh');
            watchData = [];
        }

        // Helper function to save watch data incrementally
        const saveWatchData = () => {
            try {
                fs.writeFileSync(watchDataPath, JSON.stringify(watchData, null, 2));
                console.log(`💾 Saved ${watchData.length} watch(es) to watchData.json`);
            } catch (error) {
                console.error(`❌ Error saving watchData.json: ${error.message}`);
            }
        };

        // Batch processing configuration
        const CONCURRENT_REQUESTS = 10; // Number of requests to send simultaneously
        let processedCount = 0;
        let successCount = 0;
        let failCount = 0;

        // Process URLs in batches
        for (let batchStart = 0; batchStart < watchUrls.length; batchStart += CONCURRENT_REQUESTS) {
            const batchEnd = Math.min(batchStart + CONCURRENT_REQUESTS, watchUrls.length);
            const batch = watchUrls.slice(batchStart, batchEnd);
            const batchNumber = Math.floor(batchStart / CONCURRENT_REQUESTS) + 1;
            const totalBatches = Math.ceil(watchUrls.length / CONCURRENT_REQUESTS);

            console.log(`\n📦 Batch ${batchNumber}/${totalBatches}: Processing ${batch.length} watch(es) concurrently...`);

            // Process all URLs in the batch concurrently
            const batchPromises = batch.map(async (watchUrl, batchIndex) => {
                const globalIndex = batchStart + batchIndex + 1;
                try {
                    console.log(`  [${globalIndex}/${watchUrls.length}] Processing: ${watchUrl}`);
                    const details = await scrapeWatchDetails(watchUrl);
                    
                    if (details) {
                        console.log(`  ✅ Successfully scraped watch ${globalIndex}`);
                        return { 
                            success: true, 
                            index: globalIndex,
                            data: {
                                index: globalIndex, // Explicit extraction order index
                                brand: details.brand,
                                model: details.model,
                                referenceNumber: details.referenceNumber,
                                year: details.year,
                                price: details.price,
                                currency: details.currency,
                                originalBox: details.originalBox,
                                originalPaper: details.originalPaper,
                                condition: details.condition,
                                location: details.location,
                                images: details.images,
                                watchUrl: details.watchUrl
                            }
                        };
                    } else {
                        console.log(`  ❌ Failed to scrape watch ${globalIndex}`);
                        return { success: false, index: globalIndex };
                    }
                } catch (error) {
                    console.log(`  ❌ Error scraping watch ${globalIndex}: ${error.message}`);
                    return { success: false, index: globalIndex, error: error.message };
                }
            });

            // Wait for all requests in the batch to complete
            const results = await Promise.allSettled(batchPromises);
            
            // Collect successful results and add them to watchData (maintain order)
            const batchResults = [];
            let batchSuccess = 0;
            let batchFail = 0;
            
            results.forEach((result) => {
                processedCount++;
                if (result.status === 'fulfilled' && result.value && result.value.success && result.value.data) {
                    batchResults.push(result.value.data);
                    successCount++;
                    batchSuccess++;
                } else {
                    failCount++;
                    batchFail++;
                }
            });
            
            // Add all successful results to watchData (sorted by index to maintain order)
            batchResults.sort((a, b) => a.index - b.index);
            watchData.push(...batchResults);

            // Save data after each batch completes
            saveWatchData();
            console.log(`  📊 Batch ${batchNumber} complete: ${batchSuccess} succeeded, ${batchFail} failed (${processedCount}/${watchUrls.length} total)`);

            // Small delay between batches to avoid overwhelming the server
            if (batchEnd < watchUrls.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log('\n========================================');
        console.log('Summary');
        console.log('========================================');
        console.log(`Total URLs processed: ${watchUrls.length}`);
        console.log(`Successfully scraped: ${watchData.length}`);
        console.log(`Failed: ${watchUrls.length - watchData.length}`);
        
        if (watchData.length > 0) {
            const brands = watchData.filter(w => w.brand).map(w => w.brand);
            const uniqueBrands = [...new Set(brands)];
            console.log(`\nBrands found: ${uniqueBrands.length}`);
            console.log(`  ${uniqueBrands.slice(0, 10).join(', ')}${uniqueBrands.length > 10 ? '...' : ''}`);
            
            const totalImages = watchData.reduce((sum, w) => sum + (w.images ? w.images.length : 0), 0);
            console.log(`\nTotal images collected: ${totalImages}`);
            console.log(`Average images per watch: ${(totalImages / watchData.length).toFixed(1)}`);
            
            const withBox = watchData.filter(w => w.originalBox).length;
            const withPaper = watchData.filter(w => w.originalPaper).length;
            console.log(`\nWatches with original box: ${withBox}`);
            console.log(`Watches with original papers: ${withPaper}`);
        }
        
        console.log('\n========================================\n');

        // Final save (already saved incrementally, but save once more for confirmation)
        saveWatchData();
        console.log(`✅ Final watch data saved to ${watchDataPath} (${watchData.length} items)`);

        try {
            const response = await axios.post(config.BACK_END_URL, {
                parentUrl: config.PARENT_URL,
                watchData: watchData
            }, {
                timeout: 10000
            });
            console.log('✅ Watch data posted successfully to backend');
        } catch (error) {
            console.log('⚠️  Could not post to backend (this is OK if backend is not running):', error.message);
        }

        return watchData;
    } catch (error) {
        console.error('Error scraping watch data:', error.message);
        return [];
    } finally {
        await closeBrowser();
    }
}

const startScheduler = async () => {
    const SCRAPE_INTERVAL = 10 * 60 * 60 * 1000; // 10 hours in milliseconds

    console.log('Starting scheduler...');
    console.log(`Scraping interval: 10 hours (${SCRAPE_INTERVAL / 1000 / 60} minutes)`);

    console.log('Running initial scrape...');
    await scrapeWatchData();

    setInterval(async () => {
        try {
            console.log('Running scheduled scrape...');
            await scrapeWatchData();
        } catch (error) {
            console.error('Error in scheduled scrape:', error.message);
        }
    }, SCRAPE_INTERVAL);

}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down scheduler...');
    await closeBrowser();
    process.exit(0);
});

// Start the scheduler
startScheduler()
