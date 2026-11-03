import { render } from 'preact';
import { App } from './app/App';
import { openStore } from './store/board-store';
import { initMode } from './ui/mode';
import './ui/styles';

initMode();
const store = await openStore();
render(<App store={store} />, document.getElementById('root')!);
