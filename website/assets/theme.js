try { document.documentElement.dataset.theme = localStorage.getItem('castles-theme') === 'light' ? 'light' : 'dark'; } catch { /* Dark is the default when storage is unavailable. */ }
