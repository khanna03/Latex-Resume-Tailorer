/**
 * PDF Parser — Client-side PDF text extraction using PDF.js
 * Extracts raw text from a PDF file for conversion to LaTeX via Gemini.
 */

import * as pdfjsLib from 'pdfjs-dist';

// PDF.js requires a worker. Use the bundled worker from the package.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/**
 * Extract all text content from a PDF File object.
 * Returns text page-by-page, preserving rough structure.
 *
 * @param {File} file - A PDF File from a file input / drag-drop
 * @returns {Promise<string>} Extracted plain text
 */
export async function extractTextFromPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Join text items, inserting newlines when Y position changes significantly
    let lastY = null;
    let pageText = '';
    for (const item of textContent.items) {
      if ('str' in item) {
        const y = item.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 5) {
          pageText += '\n';
        }
        pageText += item.str;
        lastY = y;
      }
    }
    pageTexts.push(pageText.trim());
  }

  return pageTexts.join('\n\n--- Page Break ---\n\n');
}
