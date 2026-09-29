import React, { useEffect, useRef, useState } from 'react';
import { cropImageStyle, fitCropToRatio, initialCrop } from './lib/imageCrop.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function ImageSlotPreview({ src, crop, focus, alt = '当前图片' }) {
  const ref = useRef(null);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const image = node.querySelector('img');
      if (image?.naturalWidth && image?.naturalHeight) setSize({ imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, width: node.clientWidth, height: node.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [src]);
  return <div ref={ref} className="day-slot-focus-preview"><img src={src} alt={alt} onLoad={(event) => {
    const node = event.currentTarget.parentElement;
    setSize({ imageWidth: event.currentTarget.naturalWidth, imageHeight: event.currentTarget.naturalHeight, width: node.clientWidth, height: node.clientHeight });
  }} style={{ objectPosition: focus, ...size && cropImageStyle(crop, size.imageWidth, size.imageHeight, size.width, size.height) }} /></div>;
}

export function ImageCropEditor({ src, crop, focus, targetRatio, onCommit }) {
  const outerRef = useRef(null);
  const dragRef = useRef(null);
  const [outerWidth, setOuterWidth] = useState(320);
  const [size, setSize] = useState(null);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    const image = new Image();
    image.onload = () => setSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => setSize(null);
    image.src = src;
    return () => { image.onload = null; image.onerror = null; };
  }, [src]);
  useEffect(() => {
    if (!outerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setOuterWidth(entry.contentRect.width));
    observer.observe(outerRef.current);
    return () => observer.disconnect();
  }, []);
  const ratio = size ? size.width / size.height : 1;
  const boxWidth = Math.min(outerWidth, 300 * ratio);
  const boxHeight = boxWidth / ratio;
  const effectiveRatio = targetRatio > 0 ? targetRatio : 16 / 9;
  const selected = size && (draft || fitCropToRatio(crop, size.width, size.height, effectiveRatio) || initialCrop(size.width, size.height, effectiveRatio, focus));
  useEffect(() => setDraft(null), [src, crop, focus, targetRatio]);

  const start = (event, mode) => {
    if (!selected) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, rect: selected };
  };
  const move = (event) => {
    const drag = dragRef.current;
    if (!drag || !size) return;
    const dx = (event.clientX - drag.startX) / boxWidth;
    const dy = (event.clientY - drag.startY) / boxHeight;
    const base = drag.rect;
    if (drag.mode === 'move') {
      setDraft({ ...base, x: clamp(base.x + dx, 0, 1 - base.width), y: clamp(base.y + dy, 0, 1 - base.height) });
      return;
    }
    const sx = drag.mode.includes('left') ? -1 : 1;
    const sy = drag.mode.includes('top') ? -1 : 1;
    const normalizedRatio = effectiveRatio / ratio;
    const change = Math.abs(dx) > Math.abs(dy * normalizedRatio) ? sx * dx : sy * dy * normalizedRatio;
    const anchorX = sx > 0 ? base.x : base.x + base.width;
    const anchorY = sy > 0 ? base.y : base.y + base.height;
    const maxWidthX = sx > 0 ? 1 - anchorX : anchorX;
    const maxWidthY = (sy > 0 ? 1 - anchorY : anchorY) * normalizedRatio;
    const width = clamp(base.width + change, Math.min(0.12, Math.min(maxWidthX, maxWidthY)), Math.min(maxWidthX, maxWidthY));
    const height = width / normalizedRatio;
    setDraft({ x: sx > 0 ? anchorX : anchorX - width, y: sy > 0 ? anchorY : anchorY - height, width, height });
  };
  const end = () => {
    if (dragRef.current && draft) onCommit(draft);
    dragRef.current = null;
  };

  return <div className="crop-editor" ref={outerRef}>
    <p>拖动框选择画面，拖动角点调整范围。比例已与成品图片位保持一致。</p>
    {size && selected ? <div className="crop-editor-source" style={{ width: boxWidth, height: boxHeight }}>
      <img src={src} alt="待裁切原图" draggable="false" />
      <div className="crop-editor-shade" />
      <div className="crop-editor-selection" role="group" aria-label="图片裁切范围" style={{ left: `${selected.x * 100}%`, top: `${selected.y * 100}%`, width: `${selected.width * 100}%`, height: `${selected.height * 100}%` }} onPointerDown={(event) => start(event, 'move')} onPointerMove={move} onPointerUp={end} onLostPointerCapture={end}>
        {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((corner) => <span key={corner} className={`crop-handle crop-handle-${corner}`} onPointerDown={(event) => { event.stopPropagation(); start(event, corner); }} />)}
      </div>
    </div> : <div className="crop-editor-loading">正在读取图片…</div>}
  </div>;
}
