# UTNC Toronto Scavenger Hunt

A small web app for the club scavenger hunt. Teams log in on their phones with a team code, snap photos at checkpoints and submit them. Points are tracked automatically, crowded spots lose value, and organizers review every photo from one dashboard.

- `index.html`: the team page
- `admin.html`: the organizer dashboard
- `supabase/setup.sql`: creates the database, scoring rules, photo storage and all 46 items

The site is hosted on GitHub Pages (free). Photos and scores live in Supabase (free tier).

---

## Setup (about 20 minutes)

### 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**. Any name and region works (pick one in Canada or the US East for speed).
2. Wait for it to finish provisioning.

### 2. Run the setup script

1. In the project, open **SQL Editor** and click **New query**.
2. Paste in the whole of `supabase/setup.sql` and click **Run**.
3. The result table at the bottom lists the **admin code** and codes for five starter teams. Save the admin code somewhere safe. It's also in the `config` table under **Table Editor**. You don't need to keep the team codes, since you'll manage teams from the dashboard.

The script is safe to re-run. It won't duplicate anything or delete photos.

### 3. Connect the site to Supabase

1. In Supabase, open **Project Settings > API** (on newer projects this may be under **API Keys**).
2. Copy the and the public key. That's the one labelled **anon** or **publishable**, never the `service_role` or secret key. Seriously, **_never ever_**, leak the secret one.
3. Copy the **Project URL** on the landing page of the project.
4. Open `js/config.js` and paste them in:

```js
supabaseUrl: "https://abcdefgh.supabase.co",
supabaseKey: "eyJhbGciOi...",   // or sb_publishable_...
```

The public key is designed to be visible in page code. The setup script locks the database so the key alone can't read or change anything; every action goes through functions that check a team or admin code.

### 4. Publish on GitHub Pages

1. Create a new GitHub repository (public is fine) and upload all the files, keeping the folder structure.
2. Go to **Settings > Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, and save.
3. After a minute or two your site is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.
   - Teams use that link.
   - You use `.../admin.html`.

### 5. Do a test run

1. Open the team page on your phone, enter a team code and submit a photo or two.
2. Open `admin.html`, enter the admin code, and check the photos show up. Try rejecting one and watch the score change.
3. In **Settings**, use **Reset after a test run** to clear everything.

---

## On the day

- **The day before:** open `admin.html`. Free Supabase projects pause after a period of inactivity, and this wakes it up.
- **Set the hard stop** in Settings. Photos submitted after it are refused, and teams see a countdown. Optionally set an opening time too.
- **Set up teams once you know numbers.** Go to Settings and add, rename or remove teams, then hand out codes at the briefing. Codes aren't case-sensitive.
- **Late arrivals or a lost code?** Add a team on the spot, or use **New code** to replace a leaked one (the old code stops working immediately).
- **During the hunt:** the Photos tab refreshes every 20 seconds. Reject anything that doesn't meet the rules (whole team plus the noodle). Untick a bonus if the answer is wrong.
- **At the finish:** use **Scores > Add points at the finish** for the snack swap, teammate quiz and late penalties. There are preset buttons for each.
- **Leaderboard:** it's visible to teams by default. Turn it off in Settings if you'd rather reveal results at dinner.

---

## How scoring works

All scoring happens in the database, so every phone sees the same numbers.

| Rule | Details |
|---|---|
| Photos count immediately | Every submission scores right away. Rejecting it removes the points. |
| Crowded spots lose value | Each extra team claiming a checkpoint lowers its value for every subsequent team that claims it, down to 50% of the total value. Better get to those spots fast! |
| Campus cap | Only each team's best 8 campus stops count. |
| Anywhere challenges | No crowd penalty. Some can be claimed more than once (for example, up to 2 team selfies). |
| Bonuses | Flat points, counted once per team per checkpoint. Organizers can untick wrong answers. |
| Adjustments | Manual points or penalties added from the dashboard. |

Teams will see what a spot is worth *if they go*, with the original value struck through, so they can steer toward quieter spots.

### Tuning

**Teams:** everything happens in the dashboard's **Settings** tab.

- **Add a team:** a code is generated automatically.
- **Rename a team:** type the new name and hit Save.
- **New code:** replaces a lost or leaked code.
- **Remove a team:** tap twice. If the team already submitted photos, the button warns you, since removing it also deletes its photos and points.

Crowd values rebalance automatically when the team count changes, including mid-hunt. Rerunning `setup.sql` never re-adds teams you removed.

**Crowd penalty examples** for a 45-point spot, by how many teams claim it:

| Teams playing | 1 team | 2 | 3 | ... | All teams |
|---|---|---|---|---|---|
| 3 | 45 | 34 | 23 | | 23 |
| 5 | 45 | 39 | 34 | 28 | 23 |
| 10 | 45 | 42 | 40 | 37 | 23 |

**Other knobs** in Supabase **Table Editor > config**:

| Column | Default | Meaning |
|---|---|---|
| `crowd_scaled` | true | Scale the penalty to the team count (also a toggle in Settings) |
| `floor_mult` | 0.5 | Share of base value a spot is worth when every team claims it |
| `decay` | 0.15 | Only used if `crowd_scaled` is off: value lost per extra team |
| `campus_cap` | 8 | Campus stops that count per team (also editable in Settings) |

To change checkpoints, tasks or points, edit the item list near the bottom of `setup.sql` and run it again. Existing photos are kept. To remove an item completely, delete its row in **Table Editor > items**.

---

## Things to know

- **Team codes are the only lock.** Anyone with a team's code can submit as that team, so share codes in person or in team chats, not the main club channel.
- **Photo links are unguessable but not private.** Anyone with a photo's exact link can view it, and nobody can browse the collection. Since the photos show people, delete the bucket's contents after the event (**Storage > hunt-photos**, select all, delete).
- **Photos are shrunk on the phone** to a few hundred KB before uploading, so bad signal is less of a problem and free storage goes a long way. Uploads retry automatically if the connection drops.
- **The app can't check photos.** Auto-scoring is a starting point, and the organizer review is what keeps it honest.
- **Some iPhone photo formats** may not open in desktop Chrome during testing. Phones themselves handle this fine.
