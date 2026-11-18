import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <div className="boot-screen"><div className="boot-error" role="alert"><h2>页面遇到一点问题</h2><p>页面暂时无法显示，请重新加载工作台。</p><button className="button primary" onClick={() => window.location.reload()}>重新加载</button></div></div>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
