---
title: Put your station on the map
date: 2026-06-04
category: Feature
author: The SUB/WAVE desk
excerpt: The new /stations page is a live directory of SUB/WAVE stations around the world. Add yours with a short form and it shows what it is playing the moment it merges.
---

SUB/WAVE is self-hosted, so anyone can run their own station. Until now there was no way to find out who else did. The new /stations page is a directory of stations around the world, with a map and a grid that shows who is on the air right now.

## What's new

Visit /stations and you get three things:

- **A live grid of station cards**, each showing what it's playing this second.
- **A world map** with every station plotted as a dot and labelled by city.
- **A strip at the top** counting the stations and countries on the network.

Each card checks its station's public now-playing feed straight from your browser and refreshes every 30 seconds. It flips between ON AIR with the artist and title, and Offline when a station is down or unreachable. Nothing is mocked up. The cards are reading the real streams.

## How to use it

Adding your station takes a minute and needs no fork. On the page, click "Add your station". It opens a short GitHub form where you fill in the name, public URL, location, latitude and longitude, genre, and a one-line description. Submit it and a bot opens the pull request for you in the community catalog, and a maintainer reviews and merges it. Your card then appears on the map and starts showing its live now-playing, as long as your controller is reachable. Cross-origin requests are already open, so there is nothing to configure on your end.

## Why it helps

A self-hosted network is invisible by default. This gives it a home. You can see who else is running a station, hear what they are playing right now, and add your own to the map in a couple of minutes. One file per station keeps submissions easy to review and easy to revert, so the directory grows by contribution without getting messy.
