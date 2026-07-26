#!/usr/bin/env python3
"""
tools/admin/serve.py — dead-simple static server for the Mesa admin tool.

Pinned to 127.0.0.1:8322 on purpose: the Mesa sync worker's ALLOWED_ORIGINS
list (worker/sync.js) already contains 'http://127.0.0.1:8322' and
'http://localhost:8322' so /auth/google/start's return_to check accepts
this origin. Serving from file:// would send Origin: null and the sign-in
redirect would be rejected; any other port would 400 the same way. Do not
change the port here without also changing the worker's allow-list.

Usage:
    python3 tools/admin/serve.py
    open http://127.0.0.1:8322/
"""
import http.server
import socketserver
import os

PORT = 8322
HOST = "127.0.0.1"

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Never let the browser cache this page across edits/reloads — same
        # trap noted in the app's own serve_app.py convention.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet by default; uncomment to debug requests.
        pass


if __name__ == "__main__":
    with socketserver.TCPServer((HOST, PORT), Handler) as httpd:
        print(f"Mesa admin tool serving on http://{HOST}:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
