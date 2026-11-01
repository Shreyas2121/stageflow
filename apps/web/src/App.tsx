import { Link, Route, Routes } from 'react-router';
import { HomePage } from './pages/HomePage';
import { RoomPage } from './pages/RoomPage';

export function App() {
  return (
    <div className="app-layout">
      <header className="site-header">
        <Link to="/" className="brand" aria-label="StageFlow home">
          <span className="brand-mark" aria-hidden="true">
            s<span>f</span>
          </span>
          StageFlow
        </Link>
        <span className="build-label">
          Presence build <span className="build-number">02</span>
        </span>
      </header>
      <main id="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/r/:slug" element={<RoomPage />} />
          <Route
            path="*"
            element={
              <section className="page-state">
                <p className="eyebrow">404 / Not found</p>
                <h1>This page does not exist.</h1>
                <Link className="text-link" to="/">
                  Back to home <span aria-hidden="true">↗</span>
                </Link>
              </section>
            }
          />
        </Routes>
      </main>
      <footer className="site-footer">
        <span>StageFlow / Presence</span>
        <span>Guest sessions · Green room · Roster</span>
      </footer>
    </div>
  );
}
