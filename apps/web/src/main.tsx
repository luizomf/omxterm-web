import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

// Do not wrap the app in React StrictMode here.
// StrictMode intentionally mounts effects twice in development, which opens two
// terminal WebSockets with the same single-use ticket. The backend correctly
// consumes the first ticket and rejects the second one as replayed.
createRoot(document.getElementById('root')!).render(<App />);
