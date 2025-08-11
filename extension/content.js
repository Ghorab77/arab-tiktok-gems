/*
  Content script for TikTok scanner
  - Injects face-api.js from extension resources
  - Loads models from CDN
  - Scans visible <video> elements on For You page
  - Filters by Arabic letters in description and female detection in a captured frame
  - Saves matches to chrome.storage.local under key 'tt_matches'
*/

(() => {
  const STATE = {
    scanning: false,
    intervalId: null,
    faceApiReady: false,
    processing: new Set(),
  };

  const CONFIG = {
    scanIntervalMs: 3500,
    femaleProbThreshold: 0.7,
    modelsURL: 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/models',
  };

  const isArabic = (text) => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text || '');

  function isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top < vh &&
      rect.bottom > 0 &&
      rect.left < vw &&
      rect.right > 0
    );
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function injectFaceApi() {
    if (STATE.faceApiReady) return true;
    return new Promise((resolve, reject) => {
      try {
        const url = chrome.runtime.getURL('vendor/face-api.min.js');
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = async () => {
          try {
            // @ts-ignore
            if (!window.faceapi) throw new Error('face-api not found after injection');
            // @ts-ignore
            await window.faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.modelsURL);
            // @ts-ignore
            await window.faceapi.nets.ageGenderNet.loadFromUri(CONFIG.modelsURL);
            STATE.faceApiReady = true;
            console.log('[TT-Scanner] face-api loaded and models ready');
            resolve(true);
          } catch (e) {
            console.error('[TT-Scanner] Failed to load models', e);
            reject(e);
          }
        };
        s.onerror = (e) => {
          console.error('[TT-Scanner] Failed to inject face-api script', e);
          reject(e);
        };
        (document.head || document.documentElement).appendChild(s);
      } catch (err) {
        reject(err);
      }
    });
  }

  function extractDescriptionForVideo(video) {
    // Try common TikTok selectors near the video element
    // 1) data-e2e markers
    let el = video.closest('[data-e2e]');
    if (el) {
      const desc1 = el.querySelector('[data-e2e="video-desc"], [data-e2e="browse-video-desc"], [data-e2e="feed-video-desc"]');
      if (desc1 && desc1.textContent?.trim()) return desc1.textContent.trim();
    }
    // 2) Nearby text blocks
    let parent = video.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const candidates = parent.querySelectorAll('div, span, strong, p');
      for (const c of candidates) {
        const txt = c.textContent?.trim() || '';
        if (txt && txt.length >= 2 && /[#@\p{L}\p{N}]/u.test(txt)) {
          // Heuristic: choose longest text as description-like
          if (isArabic(txt)) return txt;
        }
      }
      parent = parent.parentElement;
    }
    // 3) Fallback: aria-label/title
    const alt = video.getAttribute('aria-label') || video.getAttribute('title') || '';
    return alt.trim();
  }

  function findVideoUrl(video) {
    const anchor = video.closest('a[href*="/video/"]') || (video.parentElement && video.parentElement.querySelector('a[href*="/video/"]'));
    if (anchor && anchor.href) return anchor.href;
    // Fallback to current location with possible ID in dataset
    return location.href;
  }

  async function detectFemaleOnFrame(video) {
    try {
      // @ts-ignore
      const faceapi = window.faceapi;
      if (!STATE.faceApiReady || !faceapi) return { isFemale: false, prob: 0 };

      const w = Math.max(1, video.videoWidth || 0);
      const h = Math.max(1, video.videoHeight || 0);
      if (w < 2 || h < 2) return { isFemale: false, prob: 0 };

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { isFemale: false, prob: 0 };
      ctx.drawImage(video, 0, 0, w, h);

      const detections = await faceapi
        .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
        .withAgeAndGender();

      if (!detections || detections.length === 0) return { isFemale: false, prob: 0 };

      // If any face has gender female over threshold -> positive
      let maxProb = 0;
      for (const d of detections) {
        if (d.gender === 'female') {
          maxProb = Math.max(maxProb, d.genderProbability || 0);
        }
      }
      return { isFemale: maxProb >= CONFIG.femaleProbThreshold, prob: maxProb };
    } catch (e) {
      console.warn('[TT-Scanner] detectFemaleOnFrame error', e);
      return { isFemale: false, prob: 0 };
    }
  }

  async function saveMatch(record) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['tt_matches'], (res) => {
        const list = Array.isArray(res.tt_matches) ? res.tt_matches : [];
        // de-dupe by url + description
        const exists = list.some((x) => x.url === record.url || (record.description && x.description === record.description));
        if (!exists) {
          list.push(record);
          chrome.storage.local.set({ tt_matches: list }, () => resolve(true));
        } else {
          resolve(false);
        }
      });
    });
  }

  async function processVideo(video) {
    try {
      if (!(video instanceof HTMLVideoElement)) return;
      const key = video.currentSrc || video.src || video.dataset.scanKey || Math.random().toString(36).slice(2);
      if (STATE.processing.has(key)) return;
      STATE.processing.add(key);

      // Filter: only visible videos
      if (!isElementInViewport(video)) {
        STATE.processing.delete(key);
        return;
      }

      const description = extractDescriptionForVideo(video);
      if (!isArabic(description)) {
        STATE.processing.delete(key);
        return; // requires Arabic letters
      }

      const { isFemale, prob } = await detectFemaleOnFrame(video);
      if (!isFemale) {
        STATE.processing.delete(key);
        return;
      }

      const url = findVideoUrl(video);
      const thumbnail = video.poster || null;

      const record = {
        url,
        description,
        prob,
        collectedAt: new Date().toISOString(),
        page: location.href,
        poster: thumbnail,
      };

      await saveMatch(record);
      console.log('[TT-Scanner] Saved match', record);
      STATE.processing.delete(key);
    } catch (e) {
      console.error('[TT-Scanner] processVideo error', e);
    }
  }

  async function scanOnce() {
    try {
      const videos = Array.from(document.querySelectorAll('video'));
      for (const v of videos) {
        processVideo(v);
      }
    } catch (e) {
      console.error('[TT-Scanner] scanOnce error', e);
    }
  }

  async function startScanning() {
    if (STATE.scanning) return true;
    console.log('[TT-Scanner] Starting scan...');
    try {
      await injectFaceApi();
    } catch (e) {
      console.error('[TT-Scanner] Cannot start scan due to face-api load failure');
      return false;
    }
    STATE.scanning = true;
    await scanOnce();
    STATE.intervalId = setInterval(scanOnce, CONFIG.scanIntervalMs);
    return true;
  }

  function stopScanning() {
    if (!STATE.scanning) return true;
    console.log('[TT-Scanner] Stopping scan');
    if (STATE.intervalId) clearInterval(STATE.intervalId);
    STATE.intervalId = null;
    STATE.scanning = false;
    STATE.processing.clear();
    return true;
  }

  // Message API for popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'START_SCAN') {
        const ok = await startScanning();
        sendResponse({ ok, scanning: STATE.scanning, faceApiReady: STATE.faceApiReady });
      } else if (msg?.type === 'STOP_SCAN') {
        const ok = stopScanning();
        sendResponse({ ok, scanning: STATE.scanning });
      } else if (msg?.type === 'GET_STATUS') {
        sendResponse({ scanning: STATE.scanning, faceApiReady: STATE.faceApiReady });
      } else if (msg?.type === 'CLEAR_LIST') {
        chrome.storage.local.set({ tt_matches: [] }, () => sendResponse({ ok: true }));
      } else if (msg?.type === 'GET_MATCHES') {
        chrome.storage.local.get(['tt_matches'], (res) => {
          sendResponse({ ok: true, matches: res.tt_matches || [] });
        });
      }
    })();
    return true; // keep the message channel open for async
  });

  // Optional: auto-start on For You route
  const autoStart = /tiktok\.com\/(foryou|@|)/.test(location.href);
  if (autoStart) {
    // delay a bit to allow feed to load
    setTimeout(() => {
      startScanning();
    }, 4000);
  }
})();
