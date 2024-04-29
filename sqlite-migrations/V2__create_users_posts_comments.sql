CREATE TABLE users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

CREATE TABLE posts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    fk_user INTEGER
);

CREATE TABLE comments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment TEXT NOT NULL,
    fk_user INTEGER NOT NULL,
    fk_post INTEGER NOT NULL
);

CREATE TABLE roles(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL DEFAULT 'user',
    fk_user INTEGER NOT NULL
);