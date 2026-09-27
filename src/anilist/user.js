'use strict';
const { request } = require('./client');

const USER_LIST_QUERY = `
query ($username: String) {
  User(name: $username) {
    id
    name
    mediaListOptions { scoreFormat }
  }
  MediaListCollection(userName: $username, type: MANGA) {
    lists {
      entries {
        mediaId
        score
        status
      }
    }
  }
}`;

async function fetchUserList(username) {
    const data = await request(USER_LIST_QUERY, { username });

    if (!data.User) {
        const err = new Error(`User "${username}" not found`);
        err.code = 'USER_NOT_FOUND';
        throw err;
    }

    if (!data.MediaListCollection) {
        const err = new Error(`"${username}"'s list is private`);
        err.code = 'PRIVATE_LIST';
        throw err;
    }

    const scoreFormat = data.User.mediaListOptions?.scoreFormat || 'POINT_10';

    // Flatten all sub-lists (Completed, Reading, etc.) into one array
    const entries = data.MediaListCollection.lists
        .flatMap(list => list.entries)
        .filter(Boolean);

    return { username: data.User.name, scoreFormat, entries };
}

module.exports = { fetchUserList };