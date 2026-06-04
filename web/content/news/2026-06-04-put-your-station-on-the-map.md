---
title: Put your station on the map
date: 2026-06-04
category: Feature
author: The SUB/WAVE desk
excerpt: The new /stations page is a live directory of SUB/WAVE stations around the world. Add yours with one pull request and it shows what it is playing the moment it merges.
---

SUB/WAVE is self-hosted, so anyone can run their own station. Until now there was no way to find out who else did. The new /stations page is a directory of stations around the world, with a map and a grid that shows who is on the air right now.

## What's new

Visit /stations and you get three things. A live grid of station cards, each one showing what it is playing this second. A world map with every station plotted as a dot and labelled by city. And a strip at the top counting the stations and countries on the network.

Each card checks its station's public now-playing feed straight from your browser and refreshes every 30 seconds. It flips between ON AIR with the artist and title, and Offline when a station is down or unreachable. Nothing is mocked up. The cards are reading the real streams.

## How to use it

Adding your station is one file and one pull request. On the page, click "Add your station". It opens a pre-filled GitHub editor for a new file under:

```
web/content/stations/<slug>.json
```

Fill in the name, public URL, location, latitude and longitude, genre, and a one-line description, then open the PR. Every field is documented in web/content/stations/README.md. Once it merges, your card appears on the map and starts showing its live now-playing, as long as your controller is reachable. Cross-origin requests are already open, so there is nothing to configure on your end.

## Why it helps

A self-hosted network is invisible by default. This gives it a home. You can see who else is running a station, hear what they are playing right now, and add your own to the map in a couple of minutes. One file per station keeps submissions easy to review and easy to revert, so the directory grows by contribution without getting messy.
