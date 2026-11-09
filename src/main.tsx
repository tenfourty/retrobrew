import { render } from 'preact';
import { App } from './app/App';
import { installFeedback } from './app/feedback';
import { FEEDBACK_BUILT } from './app/feedback-gate';
import { openStore } from './store/board-store';
import { initMode } from './ui/mode';
import './ui/styles';

initMode();
if (FEEDBACK_BUILT) installFeedback();
const store = await openStore();
render(<App store={store} />, document.getElementById('root')!);
