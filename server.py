import os
import csv
from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime

app = Flask(__name__)
# 允许跨域访问，因为 H5 可能在 GitHub Pages (不同域名)
CORS(app)

DATA_DIR = "received_data"
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

@app.route('/', methods=['GET'])
def probe():
    return f"🚀 Server is running! Ready to receive data at /upload (Time: {datetime.now()})"

@app.route('/upload', methods=['POST'])
def upload_data():
    print(f"\n📩 [{datetime.now().strftime('%H:%M:%S')}] 收到上传请求!")
    print(f"   - Origin: {request.headers.get('Origin')}")
    print(f"   - User-Agent: {request.headers.get('User-Agent')}")
        if not data:
            print("   ❌ 错误: 接收到的 JSON 为空")
            return jsonify({"status": "error", "message": "No data received"}), 400
        
        type = data.get('type', 'unknown')
        subject_id = data.get('subject_id', 'unknown')
        payload = data.get('payload', [])
        
        print(f"   - 数据类型: {type}")
        print(f"   - 被试 ID: {subject_id}")
        print(f"   - 数据行数: {len(payload)}")
        
        if not payload:
             return jsonify({"status": "success", "message": "Empty payload ignored"}), 200

        # 生成文件名
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{type}_{subject_id}_{timestamp}.csv"
        filepath = os.path.join(DATA_DIR, filename)
        
        # 写入 CSV
        if isinstance(payload, list) and len(payload) > 0:
            keys = payload[0].keys()
            with open(filepath, 'w', newline='', encoding='utf-8') as f:
                dict_writer = csv.DictWriter(f, fieldnames=keys)
                dict_writer.writeheader()
                dict_writer.writerows(payload)
            
            print(f"[{datetime.now()}] Saved {len(payload)} rows to {filename}")
            return jsonify({"status": "success", "message": f"Saved to {filename}"}), 200
        else:
            return jsonify({"status": "error", "message": "Invalid payload format"}), 400

    except Exception as e:
        print(f"Error handling upload: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    # --- 新增: 自动启动 ngrok 隧道 ---
    # ⚠️ 注意：ngrok 现在需要注册并使用 AuthToken
    # 1. 请前往 https://dashboard.ngrok.com/signup 免费注册
    # 2. 从 https://dashboard.ngrok.com/get-started/your-authtoken 复制您的 Token
    # 3. 将 Token 填写在下方：
    NGROK_AUTH_TOKEN = "39sdVhpasOngnia9PO02go9iors_6TQd13YP6Wsj9mRENHC5w"

    try:
        from pyngrok import ngrok
        if NGROK_AUTH_TOKEN != "YOUR_NGROK_AUTH_TOKEN_HERE":
            ngrok.set_auth_token(NGROK_AUTH_TOKEN)
        
        # 启动隧道
        public_url = ngrok.connect(5001).public_url
        print(f"🚀 系统已上线！")
        print(f"请将 script.js 中的 BACKEND_URL 修改为:")
        print(f"  const BACKEND_URL = \"{public_url}/upload\";")
        print("="*50 + "\n")
    except Exception as e:
        print("\n❌ Ngrok 启动失败。")
        if "authentication failed" in str(e):
            print("原因：未配置有效的 NGROK_AUTH_TOKEN。")
            print("解决：请在 server.py 中填入您的 Token。")
        else:
            print(f"详细错误: {str(e)}")
        print("您也可以手动运行: pip install pyngrok (如果漏装)\n")
    
    # 允许局域网访问，方便手机连接
    app.run(host='0.0.0.0', port=5001)
