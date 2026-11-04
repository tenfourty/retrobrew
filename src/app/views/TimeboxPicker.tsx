import { useEffect, useState } from 'preact/hooks';
import { REAL_MINUTE_MS, REHEARSAL_MINUTE_MS } from '../../engine/discussion';
import { TIMEBOX_MINUTES, type TopicView } from '../../engine/types';
import { Button } from '../../ui/components';
import { Segmented } from '../../ui/segmented';
import { Sheet } from '../../ui/sheet';
import { Switch } from '../../ui/switch';
import { timeboxLabel } from '../lengths';
import { lastTimebox, rememberTimebox } from '../prefs';

// The timebox picker (docs/product/mvp-screens.md, The timebox picker). The last timebox this device used is
// preselected, so starting is one tap. `restart` is true when the topic is already in Discussing.
export function TimeboxPicker(props: {
  open: boolean; opener?: HTMLElement | null; topic: TopicView | undefined; restart: boolean; rehearsal: boolean;
  onStart: (minutes: number, realMinutes: boolean) => void; onClose: () => void;
}) {
  const [minutes, setMinutes] = useState(lastTimebox);
  const [real, setReal] = useState(false);

  // "Use real minutes" is off, and the last timebox chosen, each time the picker opens.
  useEffect(() => {
    if (!props.open) return;
    setMinutes(lastTimebox());
    setReal(false);
  }, [props.open]);

  const topic = props.topic;
  if (!topic) return null;
  const minuteMs = props.rehearsal && !real ? REHEARSAL_MINUTE_MS : REAL_MINUTE_MS;
  const label = timeboxLabel(minutes, minuteMs);
  const start = () => {
    rememberTimebox(minutes);
    props.onStart(minutes, props.rehearsal && real);
  };

  return (
    <Sheet open={props.open} title={props.restart ? `Start a timer for #${topic.topicId}` : `Discuss #${topic.topicId}`} onClose={props.onClose} noClose returnFocusTo={props.opener}
      initialFocus=".mtg-picker-start">
      <p className="mtg-sheet-topic">{topic.text}</p>
      <Segmented label="Timebox" columns={3} value={minutes} onChange={setMinutes}
        options={TIMEBOX_MINUTES.map((m) => ({ value: m, label: timeboxLabel(m, minuteMs) }))} />
      {props.rehearsal ? (
        <Switch label="Use real minutes" checked={real} onChange={setReal} hint="For this topic only. Otherwise a minute here lasts 10 seconds." />
      ) : null}
      <div className="mtg-buttons">
        <Button className="mtg-picker-start" onClick={start}>{`Start ${label}`}</Button>
        <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
      </div>
    </Sheet>
  );
}
