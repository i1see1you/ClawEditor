import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297

/** Stay below common WebKit/Chromium canvas pixel caps (~2^28) to avoid blank captures. */
const MAX_HTML2CANVAS_PIXELS = 160_000_000

/**
 * Many engines reject or return blank canvases when width or height exceeds ~16k–32k
 * even if total pixel count is under the area cap. Long code/PDF exports must scale down.
 */
const MAX_HTML2CANVAS_DIMENSION = 16_384

/** Allow sub-1x scale so huge documents still capture; readability beats a blank PDF. */
const MIN_HTML2CANVAS_SCALE = 0.001

function desiredHtml2CanvasScale(): number {
  return Math.max(2, window.devicePixelRatio || 2)
}

function computeSafeHtml2CanvasScale(width: number, height: number): number {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  const desired = desiredHtml2CanvasScale()
  const maxScaleFromArea = Math.sqrt(MAX_HTML2CANVAS_PIXELS / (w * h))
  const maxScaleFromDimension = MAX_HTML2CANVAS_DIMENSION / Math.max(w, h)
  const scale = Math.min(desired, maxScaleFromArea, maxScaleFromDimension)
  return Math.max(MIN_HTML2CANVAS_SCALE, Math.floor(scale * 1000) / 1000)
}

function parsePx(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

function clampInt(n: number, min: number): number {
  return Math.max(min, Math.floor(n))
}

async function nextFrame(count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
  }
}

function hasNonLatin1(text: string): boolean {
  // jsPDF built-in fonts are limited; if text contains characters outside Latin-1,
  // prefer the HTML path (browser text rendering) unless a custom font is embedded.
  return /[^\u0000-\u00ff]/u.test(text)
}

function expandTabs(line: string, tabSize: number): string {
  if (!line.includes('\t')) return line
  let out = ''
  let col = 0
  for (const ch of line) {
    if (ch === '\t') {
      const spaces = tabSize - (col % tabSize || 0)
      out += ' '.repeat(spaces)
      col += spaces
    } else {
      out += ch
      col += 1
    }
  }
  return out
}

export async function exportTextToPdfBytes(options: {
  text: string
  title?: string
  theme: 'light' | 'dark'
}): Promise<Uint8Array> {
  const { text, title, theme } = options

  if (hasNonLatin1(text)) {
    // Fallback: without embedded fonts, jsPDF cannot reliably render CJK/emoji/etc.
    // Use the existing HTML export path which uses WebView fonts.
    const safeHtml = `<pre style="margin:0; white-space:pre; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 13px; line-height: 1.45;">${text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</pre>`
    return exportHtmlToPdfBytes({ html: safeHtml, title, theme })
  }

  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })
  const margin = 10
  const pageWidth = A4_WIDTH_MM - margin * 2
  const pageHeight = A4_HEIGHT_MM - margin * 2

  const fontSize = 10
  const lineHeight = 4.2 // ~10pt * 1.2 in mm space, tuned for readability
  const tabSize = 4

  // Export always uses white background for print-friendly PDFs.
  void theme
  const bg = '#ffffff'
  const fg = '#111111'

  const drawPageBackground = () => {
    pdf.setFillColor(bg)
    pdf.rect(0, 0, A4_WIDTH_MM, A4_HEIGHT_MM, 'F')
  }

  const setCodeStyle = () => {
    pdf.setFont('courier', 'normal')
    pdf.setFontSize(fontSize)
    pdf.setTextColor(fg)
  }

  const addNewPage = () => {
    if (pdf.getNumberOfPages() > 0) pdf.addPage()
    drawPageBackground()
    setCodeStyle()
  }

  addNewPage()

  let x = margin
  let y = margin

  if (title) {
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(12)
    pdf.setTextColor(fg)
    const titleLines = pdf.splitTextToSize(title, pageWidth)
    for (const tl of titleLines) {
      pdf.text(tl, x, y)
      y += lineHeight
      if (y > margin + pageHeight - lineHeight) {
        addNewPage()
        y = margin
      }
    }
    y += lineHeight * 0.5
    setCodeStyle()
  }

  // Monospace wrapping by width; splitTextToSize is acceptable here since we only
  // rely on it for hard wrapping, not for preserving rich spacing in proportional fonts.
  const maxWidth = pageWidth
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = expandTabs(lines[i], tabSize)
    const wrapped = pdf.splitTextToSize(raw, maxWidth)
    for (const wl of wrapped) {
      pdf.text(wl, x, y)
      y += lineHeight
      if (y > margin + pageHeight - lineHeight) {
        addNewPage()
        y = margin
      }
    }
  }

  return new Uint8Array(pdf.output('arraybuffer'))
}

export async function exportHtmlToPdfBytes(options: {
  html: string
  title?: string
  theme: 'light' | 'dark'
}): Promise<Uint8Array> {
  const { html, title, theme } = options

  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-100000px'
  container.style.top = '0'
  container.style.width = '794px' // ~A4 at 96dpi
  // Export always uses white background for print-friendly PDFs.
  void theme
  container.style.background = '#ffffff'
  container.style.color = '#111111'
  container.style.padding = '24px'
  container.style.boxSizing = 'border-box'
  container.style.overflow = 'hidden'
  container.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif'

  const exportClamp = document.createElement('style')
  exportClamp.textContent = `
    /* Snapshot-only: avoid single-line JSON blowing scrollWidth past canvas limits */
    pre, code { white-space: pre-wrap !important; word-break: break-word; overflow-wrap: anywhere; max-width: 100%; }
  `
  container.appendChild(exportClamp)

  if (title) {
    const h = document.createElement('h1')
    h.textContent = title
    h.style.fontSize = '18px'
    h.style.margin = '0 0 16px 0'
    container.appendChild(h)
  }

  const bodyViewport = document.createElement('div')
  bodyViewport.style.position = 'relative'
  bodyViewport.style.width = '100%'
  bodyViewport.style.overflow = 'hidden'

  const body = document.createElement('div')
  body.style.willChange = 'transform'
  body.innerHTML = html
  bodyViewport.appendChild(body)
  container.appendChild(bodyViewport)

  document.body.appendChild(container)

  try {
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })
    const margin = 10
    const pageWidth = A4_WIDTH_MM - margin * 2
    const pageHeight = A4_HEIGHT_MM - margin * 2

    // Ensure layout is stable (fonts/images/styles).
    await nextFrame(2)
    void container.offsetHeight

    // Set a fixed viewport height that matches A4 printable aspect ratio.
    // We capture one page at a time to keep canvas dimensions under engine limits.
    const viewportWidthPx = Math.max(1, container.clientWidth)
    let viewportHeightPx = Math.max(
      1,
      Math.round((viewportWidthPx * pageHeight) / pageWidth)
    )

    // Measure padding so we paginate the content area, not the padded frame.
    const cs = getComputedStyle(container)
    const paddingTop = parsePx(cs.paddingTop)
    const paddingBottom = parsePx(cs.paddingBottom)
    let viewportContentHeightPx = Math.max(
      1,
      viewportHeightPx - paddingTop - paddingBottom
    )

    // Stop-the-bleed: if we're exporting preformatted text (code / plain text),
    // align the page content height and page offsets to whole line heights so we
    // never slice a line into "half a line" across page boundaries.
    const pre = container.querySelector('pre')
    if (pre) {
      const preCs = getComputedStyle(pre)
      const lineHeightPx = parsePx(preCs.lineHeight)
      if (lineHeightPx > 0) {
        const linesPerPage = clampInt(viewportContentHeightPx / lineHeightPx, 1)
        const alignedContentHeightPx = Math.max(1, Math.round(linesPerPage * lineHeightPx))
        viewportContentHeightPx = alignedContentHeightPx
        viewportHeightPx = Math.max(1, Math.round(viewportContentHeightPx + paddingTop + paddingBottom))
      }
    }

    container.style.height = `${viewportHeightPx}px`
    bodyViewport.style.height = '100%'

    // Force a reflow after setting heights.
    await nextFrame(2)
    void container.offsetHeight

    const totalContentHeightPx = Math.max(1, body.scrollHeight)
    const totalPages = Math.max(
      1,
      Math.ceil(totalContentHeightPx / viewportContentHeightPx)
    )

    // Compute scale based on single-page dimensions; usually allows 2x+ without blank output.
    const scale = computeSafeHtml2CanvasScale(viewportWidthPx, viewportHeightPx)

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      const offsetPx = Math.round(pageIndex * viewportContentHeightPx)
      body.style.transform = `translateY(-${offsetPx}px)`

      // Wait for the transform to apply before snapshot.
      await nextFrame(2)

      const canvas = await html2canvas(container, {
        scale,
        backgroundColor: '#ffffff',
        useCORS: true,
      })

      const img = canvas.toDataURL('image/png')
      if (pageIndex > 0) pdf.addPage()
      pdf.addImage(img, 'PNG', margin, margin, pageWidth, pageHeight)
    }

    return new Uint8Array(pdf.output('arraybuffer'))
  } finally {
    container.remove()
  }
}

