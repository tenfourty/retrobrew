import { useMemo } from 'preact/hooks';
import { qrPath } from './qr-path';

// The QR panel (design/system/components/QrPanel): dark modules on a light ground in every theme, at least 240 px.
export function QrCode(props: { text: string; label: string }) {
  const { size, d } = useMemo(() => qrPath(props.text), [props.text]);
  return (
    <div className="rb-qr">
      <svg role="img" aria-label={props.label} viewBox={`0 0 ${size} ${size}`} shape-rendering="crispEdges">
        <path d={d} fill="currentColor" />
      </svg>
    </div>
  );
}
