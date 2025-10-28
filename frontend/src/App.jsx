export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Navbar */}
      <nav className="border-b border-gray-800 bg-gray-900 px-8 py-4 flex justify-between items-center shadow-lg">
        <h1 className="text-2xl font-bold text-yellow-400 tracking-wide">PickForge</h1>
        <div className="space-x-6">
          <a href="#" className="hover:text-yellow-300 transition-colors">Weekly Picks</a>
          <a href="#" className="hover:text-yellow-300 transition-colors">Leaderboard</a>
          <a href="#" className="hover:text-yellow-300 transition-colors">Login</a>
        </div>
      </nav>

      {/* Main Section */}
      <main className="flex-1 flex flex-col items-center justify-center text-center px-4">
        <h2 className="text-3xl font-semibold mb-2 text-yellow-300">This Week’s Lines</h2>
        <p className="text-gray-400 mb-6">Make your picks and see where you rank.</p>

        <div className="w-full max-w-2xl bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-md">
          <p className="text-gray-500">Game board will go here 🏈</p>
        </div>
      </main>

      {/* Footer */}
      <footer className="text-center py-4 border-t border-gray-800 text-sm text-gray-600 bg-gray-900">
        Built with ❤️ by <span className="text-yellow-400 font-semibold">PickForge</span>
      </footer>
    </div>
  );
}