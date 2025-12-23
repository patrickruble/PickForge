// src/App.tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Suspense, lazy } from "react";
import "./App.css";
import Header from "./components/Header";

// Lazy-loaded pages
const GameBoard = lazy(() => import("./components/GameBoard"));
const MyPicks = lazy(() => import("./pages/MyPicks"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const Stats = lazy(() => import("./pages/Stats"));
const Login = lazy(() => import("./pages/Login"));
const Username = lazy(() => import("./pages/Username"));
const AuthCallback = lazy(() => import("./pages/AuthCallback"));
const UserProfile = lazy(() => import("./pages/UserProfile"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Feed = lazy(() => import("./pages/Feed"));
const Leagues = lazy(() => import("./pages/Leagues"));
const LeagueLeaderboard = lazy(() => import("./pages/LeagueLeaderboard"));
const MyBets = lazy(() => import("./pages/MyBets"));
const ConnectSleeper = lazy(() => import("./pages/connectsleeper"));
const SleeperLeague = lazy(() => import("./pages/sleeperleague"));
const UploadSlip = lazy(() => import("./bets/pages/UploadSlip"));
const ReviewSlip = lazy(() => import("./bets/pages/ReviewSlip"));

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-[#0f1115] text-gray-100">
        <Header />

        <main className="mx-auto max-w-6xl px-4 py-12">
          <Suspense
            fallback={
              <div className="text-sm text-slate-400">Loading PickForge…</div>
            }
          >
            <Routes>
              <Route path="/" element={<GameBoard />} />
              <Route path="/mypicks" element={<MyPicks />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/login" element={<Login />} />
              <Route path="/username" element={<Username />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/feed" element={<Feed />} />
              <Route path="/leagues" element={<Leagues />} />
              <Route path="/league/:leagueId" element={<LeagueLeaderboard />} />
              <Route path="/bets" element={<MyBets />} />
              <Route path="/bets/upload" element={<UploadSlip />} />
              <Route path="/bets/review/:slipId" element={<ReviewSlip />} />
              <Route path="/u/:slug" element={<UserProfile />} />
              <Route path="/connect/sleeper" element={<ConnectSleeper />} />
              <Route path="/sleeper" element={<SleeperLeague />} />
            </Routes>
          </Suspense>
        </main>

        <footer className="mt-16 border-t border-white/5">
          <div className="mx-auto max-w-6xl px-4 py-6 text-center text-xs text-gray-400">
            Built with American Ingenuity by{" "}
            <span className="text-yellow-400">PickForge</span>
          </div>
        </footer>
      </div>
    </BrowserRouter>
  );
}