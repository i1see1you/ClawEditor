import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297

/** Stay below common WebKit/Chromium canvas pixel caps (~2^28) to avoid blank captures. */
const MAX_HTML2CANVAS_PIXELS = 160_000_000

function desiredHtml2CanvasScale(): number {
  return Math.max(2, window.devicePixelRatio || 2)
}

function computeSafeHtml2CanvasScale(width: number, height: number): number {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  let scale = desiredHtml2CanvasScale()
  if (w * h * scale * scale <= MAX_HTML2CANVAS_PIXELS) return scale
  const maxScale = Math.sqrt(MAX_HTML2CANVAS_PIXELS / (w * h))
  // Keep at least 1x so exports stay legible; huge docs may still be heavy but render.
  return Math.max(1, Math.min(scale, Math.floor(maxScale * 100) / 100))
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
  container.style.background = theme === 'dark' ? '#1e1e1e' : '#ffffff'
  container.style.color = theme === 'dark' ? '#cccccc' : '#333333'
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

  const body = document.createElement('div')
  body.innerHTML = html
  container.appendChild(body)

  document.body.appendChild(container)

  try {
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    void container.offsetHeight

    const w = Math.max(container.scrollWidth, container.offsetWidth)
    const h = Math.max(container.scrollHeight, container.offsetHeight)
    const scale = computeSafeHtml2CanvasScale(w, h)

    const canvas = await html2canvas(container, {
      scale,
      backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
      useCORS: true,
    })

    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })
    const margin = 10
    const pageWidth = A4_WIDTH_MM - margin * 2
    const pageHeight = A4_HEIGHT_MM - margin * 2

    const imgWidth = pageWidth
    const sliceHeightPx = Math.floor((canvas.width * pageHeight) / imgWidth)

    let renderedHeight = 0
    let pageIndex = 0

    while (renderedHeight < canvas.height) {
      const sliceCanvas = document.createElement('canvas')
      sliceCanvas.width = canvas.width
      sliceCanvas.height = Math.min(sliceHeightPx, canvas.height - renderedHeight)
      const ctx = sliceCanvas.getContext('2d')
      if (!ctx) break

      ctx.drawImage(
        canvas,
        0,
        renderedHeight,
        canvas.width,
        sliceCanvas.height,
        0,
        0,
        canvas.width,
        sliceCanvas.height
      )

      const sliceImg = sliceCanvas.toDataURL('image/png')
      const sliceImgHeightMm = (sliceCanvas.height * imgWidth) / canvas.width

      if (pageIndex > 0) pdf.addPage()
      pdf.addImage(sliceImg, 'PNG', margin, margin, imgWidth, sliceImgHeightMm)

      renderedHeight += sliceCanvas.height
      pageIndex += 1
    }

    return new Uint8Array(pdf.output('arraybuffer'))
  } finally {
    container.remove()
  }
}

