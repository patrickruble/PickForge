// src/App.tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./App.css";
import Header from "./components/Header";
import GameBoard from "./components/GameBoard";
import MyPicks from "./pages/MyPicks";
import Leaderboard from "./pages/Leaderboard";
import Stats from "./pages/Stats";
import Login from "./pages/Login";
import Username from "./pages/Username";
import AuthCallback from "./pages/AuthCallback";
import UserProfile from "./pages/UserProfile"; // ✅ NEW

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-[#0f1115] text-gray-100">
        <Header />

        <main className="mx-auto max-w-6xl px-4 py-12">
          <Routes>
            <Route path="/" element={<GameBoard />} />
            <Route path="/mypicks" element={<MyPicks />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/login" element={<Login />} />
            <Route path="/username" element={<Username />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/u/:userId" element={<UserProfile />} /> {/* NEW */}
          </Routes>
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