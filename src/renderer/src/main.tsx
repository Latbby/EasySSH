import { createRoot } from 'react-dom/client'
import App from './App'
import './assets/main.css'

// 这里刻意不使用 StrictMode：开发期它会把副作用执行两次，
// 而 xterm 实例与 IPC 订阅属于重量级副作用，双执行会带来重复渲染与闪烁。
createRoot(document.getElementById('root')!).render(<App />)
