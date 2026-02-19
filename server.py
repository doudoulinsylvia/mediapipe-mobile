import os
import csv
from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime

app = Flask(__name__)
# 允许跨域请求，移动端 H5 必备
CORS(app)

# 存储数据的文件夹
DATA_DIR = 'received_data'
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
    
    try:
        data = request.json
        if not data:
            print("   ❌ 错误: 接收到的 JSON 为空")
            return jsonify({"status": "error", "message": "No data received"}), 400
        
        type_str = data.get('type', 'unknown')
        subject_id = data.get('subject_id', 'unknown')
        payload = data.get('payload', [])
        
        print(f"   - 数据类型: {type_str}")
        print(f"   - 被试 ID: {subject_id}")
        print(f"   - 数据行数: {len(payload)}")
        
        if not payload:
             print("   ⚠️ 警告: 负载数据为空，跳过保存")
             return jsonify({"status": "success", "message": "Empty payload ignored"}), 200

        # 生成文件名
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{type_str}_{subject_id}_{timestamp}.csv"
        filepath = os.path.join(DATA_DIR, filename)
        
        # 写入 CSV
        if isinstance(payload, list) and len(payload) > 0:
            keys = payload[0].keys()
            with open(filepath, 'w', newline='', encoding='utf-8') as f:
                dict_writer = csv.DictWriter(f, fieldnames=keys)
                dict_writer.writeheader()
                dict_writer.writerows(payload)
            
            print(f"   ✅ 成功: 已保存 {len(payload)} 行数据到 {filename}")
            return jsonify({"status": "success", "message": f"Saved to {filename}"}), 200
        else:
            print("   ❌ 错误: 无效的负载格式 (不是列表)")
            return jsonify({"status": "error", "message": "Invalid payload format"}), 400

    except Exception as e:
        print(f"   ❌ 异常: 处理上传时发生错误: {str(e)}")
        import traceback
        traceback.print_exc()
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
        
        # 启动隧道 (使用 5001 端口避开 Mac 系统占用)
        public_url = ngrok.connect(5001).public_url
        print("\n" + "="*50)
        print(f"🚀 系统已上线！")
        print(f"请确保 script.js 中的 BACKEND_URL 为:")
        print(f"  const BACKEND_URL = \"{public_url}/upload\";")
        print("="*50 + "\n")
    except Exception as e:
        print("\n❌ Ngrok 启动失败。")
        print(f"详细错误: {str(e)}")
    
    # 允许局域网访问
    app.run(host='0.0.0.0', port=5001)
