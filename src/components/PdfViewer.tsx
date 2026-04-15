import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { FileTab } from '../types'

interface PdfViewerProps {
  file: FileTab
}

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

export function PdfViewer({ file }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [scale, setScale] = useState(1.5)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadPdf = async () => {
      try {
        setError(null)
        setPdfDoc(null)

        const rawBytes =
          file.content instanceof Uint8Array
            ? file.content
            : new Uint8Array(file.content as unknown as ArrayBuffer)
        // Make sure the bytes are a plain, cloneable Uint8Array.
        const bytes = new Uint8Array(rawBytes)

        // In Tauri/WebView, pdf.js worker messaging can fail with:
        // "The object can not be cloned."
        // Disabling the worker is slower but much more reliable.
        const pdf = await pdfjsLib.getDocument({ data: bytes, disableWorker: true } as any).promise
        setPdfDoc(pdf)
        setTotalPages(pdf.numPages)
        setCurrentPage(1)
      } catch (err) {
        console.error('Failed to load PDF:', err)
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    if (file.content) {
      loadPdf()
    }
  }, [file])

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return

    const renderPage = async () => {
      const page = await pdfDoc.getPage(currentPage)
      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!
      const viewport = page.getViewport({ scale })
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1

      // Render at device pixel ratio for crisp output (retina/hi-dpi).
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      await page.render({
        canvasContext: ctx,
        viewport,
      }).promise
    }

    renderPage()
  }, [pdfDoc, currentPage, scale])

  if (error) {
    return <div className="pdf-loading">PDF 加载失败：{error}</div>
  }

  if (!pdfDoc) return <div className="pdf-loading">加载中...</div>

  return (
    <div className="pdf-viewer">
      <div className="pdf-controls">
        <button
          disabled={currentPage <= 1}
          onClick={() => setCurrentPage((p) => p - 1)}
        >
          上一页
        </button>
        <span>
          {currentPage} / {totalPages}
        </span>
        <button
          disabled={currentPage >= totalPages}
          onClick={() => setCurrentPage((p) => p + 1)}
        >
          下一页
        </button>
        <button onClick={() => setScale((s) => s * 1.2)}>放大</button>
        <button onClick={() => setScale((s) => s / 1.2)}>缩小</button>
      </div>
      <div className="pdf-canvas-wrapper">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}