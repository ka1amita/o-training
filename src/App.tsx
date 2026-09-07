import { Route, Switch, Link } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import Home from './pages/Home.tsx';
import DrillPage from './pages/DrillPage.tsx';
import MatchPage from './pages/MatchPage.tsx';
import Progress from './pages/Progress.tsx';
import { Router } from 'wouter';

export default function App() {
  // Hash routing: the app is deployed as static files, and a path-routed reload on
  // GitHub Pages is a 404 from a server that will never be configured otherwise.
  return (
    <Router hook={useHashLocation}>
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
        <header className="flex items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <Link href="/" className="text-lg font-semibold tracking-tight no-underline">
            OB&nbsp;Training
          </Link>
          <Link
            href="/progress"
            className="text-sm text-muted no-underline hover:text-paper"
          >
            Progress
          </Link>
        </header>
        <main className="flex flex-1 flex-col px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/drill/:id" component={DrillPage} />
            <Route path="/match" component={MatchPage} />
            <Route path="/match/join/:code" component={MatchPage} />
            <Route path="/progress" component={Progress} />
            <Route>
              <p className="pt-10 text-center text-muted">Nothing here.</p>
            </Route>
          </Switch>
        </main>
      </div>
    </Router>
  );
}
