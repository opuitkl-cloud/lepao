import http.server
import json
import os

PORT = 8765
SETTINGS_FILE = 'data/settings.json'

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/settings':
            if os.path.exists(SETTINGS_FILE):
                with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data.encode())
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'null')
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/settings':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            os.makedirs('data', exist_ok=True)
            with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
                f.write(body.decode('utf-8'))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404)
            self.end_headers()

print(f'Server running at http://localhost:{PORT}/')
http.server.HTTPServer(('', PORT), Handler).serve_forever()
