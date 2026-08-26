import os
import json
from dotenv import load_dotenv
import aiosqlite
import asyncio

import socketio
from quart import Quart, request, jsonify, send_from_directory

# init quart
app = Quart(__name__)

db = None

@app.before_serving
async def init_db():
    global db
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT NOT NULL,
                room TEXT NOT NULL DEFAULT 'global',
                content TEXT NOT NULL DEFAULT '',
                media TEXT,
                timestamp TEXT NOT NULL
            )
            """)
    await db.execute("CREATE TABLE IF NOT EXISTS users (username TEXT, pin TEXT, display_name TEXT, pfp TEXT, color TEXT)")
    await db.commit()

    print("Database schema started")

@app.after_serving
async def close_db():
    global db
    if db:
        await db.close()
        print("Veritabanı bağlantısı kapatıldı.")

async def execute_sql_command(db: aiosqlite.Connection, command: str, *params) -> bool:
    try:
        await db.execute(command, params)
        await db.commit()

        return True
    except Exception as err:
        print("An error was occured!", err)

        return False
    
async def fetch_one(db: aiosqlite.Connection, command: str, *params):
    try:
        async with db.execute(command, params) as cursor:
            return await cursor.fetchone()
    except Exception as err:
        print("An error occurred!", err)
        return None

async def fetch_sql_data(db: aiosqlite.Connection, command: str, *params):
    try:
        async with db.execute(command, params) as cursor:
            return await cursor.fetchall()
    except Exception as err:
        print("An error occured!", err)
        return False
        

load_dotenv()

app.config['SECRET_KEY'] = os.environ.get("SECRET_KEY")

# Official python-socketio async server, mounted onto the Quart ASGI app below
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# Path setup for local JSON database and uploads
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
DB_PATH = os.path.join(BASE_DIR, 'main.db')

try:
    IS_DEBUG_MODE = os.environ.get("DEBUG", "False").lower() == "true"
except Exception as err:
    print(err)

if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

# --- Routes for Static Files (PWA) ---
@app.route('/')
async def index():
    return await send_from_directory(BASE_DIR, "index.html")

@app.route('/<path:filename>')
async def serve_static(filename):
    return await send_from_directory(BASE_DIR, filename)

@app.route('/uploads/<path:filename>')
async def serve_uploads(filename):
    return await send_from_directory(UPLOAD_DIR, filename)

# --- API Routes ---
@app.route('/api/login', methods=['POST'])
async def login():
    data = await request.json
    username = data.get('username')
    pin = data.get('pin')

    if not username or not pin or len(pin) != 4 or not pin.isdigit():
        return jsonify({"error": "Invalid username or PIN (must be 4 digits)"}), 400

    user = await fetch_one(db, "SELECT * FROM users WHERE username = ?", username)
    if not user:
        return jsonify({"error": "User not exists"}), 401

    # buraya hashing çözme mekanizması eklenecek ... future

    if user["pin"] != pin:
        return jsonify({"error": "Incorrect PIN"}), 401

    # Return user data (excluding PIN) + chat history
    user_data = {
        k: user[k]
        for k in user.keys()
        if k != "pin"
    }
    user_data["avatar"] = user_data.pop("pfp", "")

    async with db.execute("SELECT username, display_name, pfp AS avatar, color FROM users") as cursor:
        rows = await cursor.fetchall()

    all_users = {
        row["username"]: dict(row)
        for row in rows
    }

    # A user is part of the global room, or any dm_ room whose name contains their username
    async with db.execute("""
        SELECT id, sender, room, content AS text, media, timestamp AS time
        FROM messages
        WHERE room = 'global' OR room LIKE ?
        ORDER BY id ASC
    """, (f"%{username}%",)) as cursor:
        message_rows = await cursor.fetchall()

    messages = [dict(row) for row in message_rows]

    return jsonify({
        "user": user_data,
        "users": all_users,
        "messages": messages
    })

@app.route('/api/register', methods=['POST'])
async def register():
    data = await request.json
    username = data.get('username')
    display_name = data.get('display_name')
    pin = data.get('pin')

    if not username or not pin or len(pin) != 4 or not pin.isdigit():
        return jsonify({"error": "Invalid username or PIN (must be 4 digits)"}), 400
        
    if not username.isalnum():
        return jsonify({"error": "Username must be alphanumeric"}), 400

    if not display_name:
        display_name = username

    fetched = await fetch_sql_data(db, "SELECT * FROM users WHERE username = ?", username)
    if fetched:
        return jsonify({"error": "Username already exists"}), 409

    # Register new user
    executed = await execute_sql_command(db, "INSERT INTO users (username, pin, display_name, pfp, color) VALUES (?, ?, ?, ?, ?)", username, pin, display_name, "", "#007aff")
    if executed == False:
        return jsonify({"error": "Kullanıcı ekleme başarısız"}), 500
    
    # -----old-----
    #users[username] = {
       # "pin": pin,
        # "display_name": display_name,
        # "avatar": None,  # Base64 string or URL
        # "color": "#007aff" # Default color, can randomize later
    # }
    
    user_data_response_fetch = await fetch_one(db, "SELECT username, display_name, pfp AS avatar, color FROM users WHERE username = ?", username)
    user_data = dict(user_data_response_fetch)
 
    await sio.emit('user_joined', user_data)

    rows = await fetch_sql_data(db, "SELECT username, display_name, pfp AS avatar, color FROM users")

    all_users = {
        row["username"]: {
            "username": row["username"],
            "display_name": row["display_name"],
            "avatar": row["avatar"],
            "color": row["color"]
        }
        for row in rows
    }
    async with db.execute("""
            SELECT id, sender, room, content AS text, media, timestamp AS time
            FROM messages
            WHERE room = 'global' OR room LIKE ?
            ORDER BY id ASC
        """, (f"%{username}%",)) as cursor:
            message_rows = await cursor.fetchall()
    
    messages = [dict(row) for row in message_rows]

    return jsonify({
        "user": user_data,
        "users": all_users,
        "messages": messages
    })

@app.route('/api/update_profile', methods=['POST'])
async def update_profile():
    data = await request.json

    username = data.get('username')
    display_name = data.get('display_name')
    avatar = data.get('avatar')

    if not username or not display_name:
        return jsonify({"error": "Missing required fields"}), 400

    user = await fetch_one(
        db,
        "SELECT * FROM users WHERE username = ?",
        username
    )

    if not user:
        return jsonify({"error": "User does not exist"}), 404

    executed = await execute_sql_command(
        db,
        """
        UPDATE users
        SET display_name = ?, pfp = ?
        WHERE username = ?
        """,
        display_name,
        avatar or "",
        username
    )

    if not executed:
        return jsonify({"error": "Profile update failed"}), 500

    updated_user = await fetch_one(
        db,
        """
        SELECT username, display_name, pfp AS avatar, color
        FROM users
        WHERE username = ?
        """,
        username
    )

    user_data = dict(updated_user)

    await sio.emit(
        'user_joined',
        user_data
    )

    return jsonify({
        "user": user_data
    })


# --- Socket.IO Events ---

@sio.event
async def connect(sid, environ, auth=None):
    print("Client connected")


@sio.event
async def disconnect(sid, reason=None):
    print("Client disconnected")


@sio.on('send_message')
async def handle_message(sid, data):

    sender = data.get("sender")
    room = data.get("room") or "global"
    content = data.get("text", "")
    media = data.get("media")
    timestamp = data.get("time")

    if not sender:
        return

    if not content and not media:
        return

    if not timestamp:
        import time
        timestamp = time.strftime("%H:%M")

    executed = await execute_sql_command(
        db,
        """
        INSERT INTO messages
        (sender, room, content, media, timestamp)
        VALUES (?, ?, ?, ?, ?)
        """,
        sender,
        room,
        content,
        media,
        timestamp
    )

    if not executed:
        return

    saved_message = await fetch_one(
        db,
        """
        SELECT id, sender, room, content AS text, media, timestamp AS time
        FROM messages
        WHERE id = last_insert_rowid()
        """
    )

    if not saved_message:
        return

    message = dict(saved_message)

    await sio.emit(
        'receive_message',
        message
    )


@sio.on('update_profile')
async def handle_update_profile(sid, user_data):

    username = user_data.get("username")

    if not username:
        return

    user = await fetch_one(
        db,
        """
        SELECT username, display_name, pfp AS avatar, color
        FROM users
        WHERE username = ?
        """,
        username
    )

    if not user:
        return

    await sio.emit(
        'user_joined',
        dict(user)
    )


# Combine Quart (HTTP) and Socket.IO (WS/polling) into a single ASGI app
asgi_app = socketio.ASGIApp(sio, app)


if __name__ == '__main__':
    import uvicorn

    print("Starting Kurichat Server...")
    print("Access it on your local network IP (e.g., http://192.168.x.x:5000)")

    uvicorn.run(
        "app:asgi_app",
        host='0.0.0.0',
        port=5002,
        reload=IS_DEBUG_MODE
    )