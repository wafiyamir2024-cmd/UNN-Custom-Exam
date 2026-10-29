# Online Exam for Employee Applicants

An ITIL inspired browser based multiple choice exam with separate applicant and admin links. The assessment starts with a 60 minute timer for each applicant. The admin opens or closes access, pauses and resumes active timers, changes the duration, and can adjust time for everyone or one applicant.

## Start with Docker

Start Docker Desktop, open PowerShell in this folder, and run:

~~~powershell
.\docker-start.ps1
~~~

Choose an admin password of at least 12 characters when prompted. The script builds the image, starts the site in the background, and checks that it is responding. Open http://127.0.0.1:8787/exam for applicants and http://127.0.0.1:8787/admin for administrators.

The Docker container uses the data folder in this project, so question edits, applicant records, and results remain after a container restart. To view logs or stop it from this folder:

~~~powershell
docker-compose logs -f
docker-compose down
~~~

On systems with the Docker Compose plugin, use docker compose in place of docker-compose. The helper script accepts -Port 8788 to choose another local port and -AllowNetwork to listen on the local network. Network access uses HTTP unless you put the site behind HTTPS.

## Start with Python

Install Python 3 if the python command is not available, then open PowerShell in this folder and run:

~~~powershell
python .\server.py
~~~

The server prompts you to create an admin password of at least 12 characters. Keep the PowerShell window open while applicants use the site. If you already set EXAM_ADMIN_PASSWORD in your environment, the server uses that password instead.

| Portal | Local link |
| --- | --- |
| Applicant | http://127.0.0.1:8787/exam |
| Admin | http://127.0.0.1:8787/admin |

Only one server should run at a time: the Python and C# versions use the same port and live data file.

### C# alternative

On Windows, you can run the original C# server instead:

~~~powershell
.\start.ps1
~~~

This uses the Windows .NET Framework compiler to build [server/ExamServer.cs](server/ExamServer.cs). It also prompts for an admin password.

## Run an assessment

1. Sign in at the admin link and review the question bank.
2. Set the duration and pass mark, then select **Open exam**.
3. Share the applicant link. Each applicant enters their name and IC before selecting **Begin assessment**. Their personal timer starts at that point.
4. Use the admin console to pause, resume, add or remove minutes, or finish the exam. A pause freezes every active timer. Finishing scores all active attempts immediately.
5. View scores, completion status, IC, and answer details in **Results**. Applicants receive a submission confirmation without their score.

The source folder provides 60 questions. The PDF supplies answers for 40, which are enabled on first launch. The Word document supplies 20 questions without an answer key. Those 20 appear in the admin bank as disabled until an admin enters each correct answer and enables it. Question changes affect future starts; applicants who have already begun keep their original question snapshot.

The app creates data/exam-data.json on first launch. This is the live store for settings, question edits, applicant ICs, answers, and results. Back it up and restrict access to the folder. Editing data/seed-questions.json after the first launch does not replace the live bank; use the admin view to change questions.

## Access from other computers

The default link listens only on this computer. On a trusted network, bind the Python server to the computer's network address:

~~~powershell
python .\server.py --host 192.168.1.25 --port 8787
~~~

Replace the example address with the server computer's address, and allow the port through its firewall if needed. With the C# alternative, use .\start.ps1 -Url http://192.168.1.25:8787/ instead. For real applicant traffic, put the site behind HTTPS and keep the data folder private. The app itself serves HTTP, and admin passwords and IC numbers should not travel over an untrusted network without HTTPS.

## Browser restrictions

The applicant page restricts copying, pasting, text selection, printing, context menus, and common keyboard shortcuts. It hides the exam when the page loses focus and displays a personalized watermark. A standard web page cannot reliably block operating system screenshots or snipping tools. Use a managed lockdown browser or proctored environment if capture prevention is mandatory.
