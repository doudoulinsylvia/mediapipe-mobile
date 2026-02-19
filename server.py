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

@app.route('/upload', methods=['POST'])
def upload_data():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No data received"}), 400
        
        type = data.get('type', 'unknown')
        subject_id = data.get('subject_id', 'unknown')
        payload = data.get('payload', [])
        
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
    # 允许局域网访问，方便手机连接
    # 提醒：手机需要和电脑在同一个 Wifi 下，访问电脑的局域网 IP
    app.run(host='0.0.0.0', port=5000, debug=True)
