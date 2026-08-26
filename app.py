import os
import json
from flask import Flask, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = 'kurichat-secret'
socketio = SocketIO(app, cors_allowed_origins="*")

# Path setup for local JSON database and uploads
BASE_DIR = os.path.dirname(os.path.abspath(__name__))
DB_FILE = os.path.join(BASE_DIR, 'db.json')
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')

try:
    IS_DEBUG_MODE = os.environ.get("DEBUG", "False").lower() == "true"
except Exception as err:
    print(err)

if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

# Initialize simple JSON db if missing
if not os.path.exists(DB_FILE):
    with open(DB_FILE, 'w') as f:
        json.dump({"users": {}, "messages": []}, f)

def load_db():
    with open(DB_FILE, 'r') as f:
        return json.load(f)

def save_db(data):
    with open(DB_FILE, 'w') as f:
        json.dump(data, f)

# --- Routes for Static Files (PWA) ---
@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(BASE_DIR, filename)

@app.route('/uploads/<path:filename>')
def serve_uploads(filename):
    return send_from_directory(UPLOAD_DIR, filename)

# --- API Routes ---
@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    pin = data.get('pin')

    if not username or not pin or len(pin) != 4 or not pin.isdigit():
        return jsonify({"error": "Invalid username or PIN (must be 4 digits)"}), 400

    db = load_db()
    users = db['users']

    if username not in users:
        return jsonify({"error": "User does not exist"}), 401
        
    if users[username]['pin'] != pin:
        return jsonify({"error": "Incorrect PIN"}), 401

    # Return user data (excluding PIN) + chat history
    user_data = {k: v for k, v in users[username].items() if k != 'pin'}
    user_data['username'] = username
    
    # Get all users for the chat list (excluding PINs)
    all_users = {u: {k: v for k, v in d.items() if k != 'pin'} for u, d in users.items()}
    
    return jsonify({
        "user": user_data,
        "users": all_users,
        "messages": db['messages']
    })

@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    display_name = data.get('display_name')
    pin = data.get('pin')

    if not username or not pin or len(pin) != 4 or not pin.isdigit():
        return jsonify({"error": "Invalid username or PIN (must be 4 digits)"}), 400
        
    if not username.isalnum():
        return jsonify({"error": "Username must be alphanumeric"}), 400

    if not display_name:
        display_name = username

    db = load_db()
    users = db['users']

    if username in users:
        return jsonify({"error": "Username already exists"}), 409

    # Register new user
    users[username] = {
        "pin": pin,
        "display_name": display_name,
        "avatar": None,  # Base64 string or URL
        "color": "#007aff" # Default color, can randomize later
    }

    save_db(db)
    
    # Return user data (excluding PIN) + chat history
    user_data = {k: v for k, v in users[username].items() if k != 'pin'}
    user_data['username'] = username
    
    # Inform everyone else about the new/returning user
    socketio.emit('user_joined', user_data)
    
    # Get all users for the chat list (excluding PINs)
    all_users = {username: {k: v for k, v in data.items() if k != 'pin'} for username, data in users.items()}
    
    return jsonify({
        "user": user_data,
        "users": all_users,
        "messages": db['messages']
    })

@app.route('/api/update_profile', methods=['POST'])
def update_profile():
    data = request.json
    username = data.get('username')
    display_name = data.get('display_name')
    avatar = data.get('avatar')

    if not username or not display_name:
        return jsonify({"error": "Missing required fields"}), 400

    db = load_db()
    users = db['users']

    if username not in users:
        return jsonify({"error": "User does not exist"}), 404

    users[username]['display_name'] = display_name
    if avatar:
        users[username]['avatar'] = avatar

    save_db(db)

    user_data = {k: v for k, v in users[username].items() if k != 'pin'}
    user_data['username'] = username

    return jsonify({"user": user_data})

# --- Socket.IO Events ---
@socketio.on('connect')
def handle_connect():
    print("Client connected")

@socketio.on('disconnect')
def handle_disconnect():
    print("Client disconnected")

@socketio.on('send_message')
def handle_message(data):
    db = load_db()
    
    msg = {
        "id": data.get("id"),
        "sender": data.get("sender"),
        "text": data.get("text", ""),
        "time": data.get("time"),
        "media": data.get("media", None),
        "room": data.get("room", "global")
    }
    
    db['messages'].append(msg)
    # Keep only last 1000 messages to prevent giant files
    if len(db['messages']) > 1000:
        db['messages'] = db['messages'][-1000:]
        
    save_db(db)
    
    # Broadcast to all connected clients
    emit('receive_message', msg, broadcast=True)

@socketio.on('update_profile')
def handle_update_profile(user_data):
    # Broadcast profile changes so other connected clients can instantly update UI
    emit('user_joined', user_data, broadcast=True)

if __name__ == '__main__':
    print("Starting Kurichat Server...")
    print("Access it on your local network IP (e.g., http://192.168.x.x:5000)")
    socketio.run(app, host='0.0.0.0', port=5002, debug=IS_DEBUG_MODE, allow_unsafe_werkzeug=True)
