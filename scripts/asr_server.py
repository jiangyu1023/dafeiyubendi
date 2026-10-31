# 常驻 ASR 服务：模型只加载一次，之后每条语音 1~2 秒。
# 只用标准库（http.server），避免再装 web 框架。
# 用法: python asr_server.py [port]
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9881

# ── 专名纠错 ────────────────────────────────────────────────────────────────
# funasr/Paraformer 对同音人名基本靠猜。2026-10-19 实测：样音
# 例：「张三，你听」被转成了「章叁，你听」，同音字经常错。
# 名字在对话里出现频率极高，错一次她就把人叫错，所以在这一层做固定词表替换：
# 只做「同音/近音 → 正确写法」，不做语义纠错，也不碰别的词。
# 加名字直接改这张表；改完要重启本服务（模型重载约 70 秒）。
# 注：不同人的名字写法可能不统一，没确认前不要自动改。
NAME_FIXES = {
    # 格式：'ASR 识别错的写法': '正确写法'
    # 例：
    #   '章叁': '张三',
    #   '大非鱼': '大肥鱼',
}


def fix_names(text):
    for wrong, right in NAME_FIXES.items():
        if wrong != right:
            text = text.replace(wrong, right)
    return text


print('[asr] loading funasr model ...', flush=True)
t0 = time.time()
from funasr import AutoModel  # noqa: E402

model = AutoModel(
    model='paraformer-zh',
    vad_model='fsmn-vad',
    punc_model='ct-punc',
    disable_update=True,
)
print(f'[asr] model ready in {time.time() - t0:.1f}s, listening 127.0.0.1:{PORT}', flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path.rstrip('/') != '/asr':
            self.send_error(404)
            return
        try:
            n = int(self.headers.get('content-length', 0))
            req = json.loads(self.rfile.read(n).decode('utf-8'))
            path = req.get('path')
            if not path:
                out = {'ok': False, 'error': 'path required'}
            else:
                r = model.generate(input=path, batch_size_s=300)
                text = ''.join(str(item.get('text', '')) for item in (r or []))
                text = fix_names(text.strip())
                out = {'ok': True, 'text': text}
        except Exception as error:  # noqa: BLE001
            out = {'ok': False, 'error': str(error)}
        body = json.dumps(out, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
