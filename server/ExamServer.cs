using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace ExamOnline
{
    public sealed class Question
    {
        public string id { get; set; }
        public string section { get; set; }
        public string text { get; set; }
        public List<string> options { get; set; }
        public int? correctIndex { get; set; }
        public bool enabled { get; set; }
        public string explanation { get; set; }

        public Question() { options = new List<string>(); }
    }

    public sealed class Attempt
    {
        public string id { get; set; }
        public string name { get; set; }
        public string ic { get; set; }
        public string tokenHash { get; set; }
        public string status { get; set; }
        public string registeredAtUtc { get; set; }
        public string startedAtUtc { get; set; }
        public string deadlineAtUtc { get; set; }
        public string submittedAtUtc { get; set; }
        public Dictionary<string, int> answers { get; set; }
        public List<Question> questions { get; set; }
        public int? score { get; set; }
        public double? percentage { get; set; }
        public bool? pass { get; set; }
        public int? passPercentAtSubmission { get; set; }

        public Attempt()
        {
            answers = new Dictionary<string, int>();
            questions = new List<Question>();
        }
    }

    public sealed class AppData
    {
        public string status { get; set; }
        public int durationSeconds { get; set; }
        public int passPercent { get; set; }
        public string pauseStartedAtUtc { get; set; }
        public List<Question> questions { get; set; }
        public List<Attempt> attempts { get; set; }

        public AppData()
        {
            questions = new List<Question>();
            attempts = new List<Attempt>();
        }
    }

    internal sealed class ApiError : Exception
    {
        public readonly int StatusCode;
        public ApiError(int statusCode, string message) : base(message) { StatusCode = statusCode; }
    }

    internal sealed class LoginState
    {
        public int Failures;
        public DateTime BlockedUntilUtc;
    }

    internal sealed class HeaderBag
    {
        private readonly Dictionary<string, List<string>> Values =
            new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public string this[string name]
        {
            get
            {
                List<string> entries;
                return Values.TryGetValue(name, out entries) && entries.Count > 0 ? entries[0] : null;
            }
            set { Values[name] = new List<string> { value }; }
        }
        public void Add(string name, string value)
        {
            List<string> entries;
            if (!Values.TryGetValue(name, out entries))
            {
                entries = new List<string>();
                Values[name] = entries;
            }
            entries.Add(value);
        }
        public int Count(string name)
        {
            List<string> entries;
            return Values.TryGetValue(name, out entries) ? entries.Count : 0;
        }
        public IEnumerable<KeyValuePair<string, string>> All()
        {
            foreach (KeyValuePair<string, List<string>> header in Values)
                foreach (string value in header.Value)
                    yield return new KeyValuePair<string, string>(header.Key, value);
        }
    }

    internal sealed class WebRequest
    {
        public string HttpMethod { get; private set; }
        public Uri Url { get; private set; }
        public HeaderBag Headers { get; private set; }
        public string ContentType { get { return Headers["Content-Type"]; } }
        public Stream InputStream { get; private set; }
        public Dictionary<string, string> Cookies { get; private set; }
        public IPEndPoint RemoteEndPoint { get; private set; }
        public bool IsSecureConnection { get { return false; } }

        public static WebRequest Read(BufferedStream input, IPEndPoint remote)
        {
            MemoryStream headerBytes = new MemoryStream();
            int matched = 0;
            while (true)
            {
                int next = input.ReadByte();
                if (next < 0) throw new ApiError(400, "Incomplete HTTP request.");
                headerBytes.WriteByte((byte)next);
                if (headerBytes.Length > 32768) throw new ApiError(431, "Request headers are too large.");
                int expected = "\r\n\r\n"[matched];
                if (next == expected) matched++;
                else matched = next == '\r' ? 1 : 0;
                if (matched == 4) break;
            }
            string headerText = Encoding.ASCII.GetString(headerBytes.ToArray());
            string[] lines = headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] firstLine = lines[0].Split(' ');
            if (firstLine.Length != 3 || !firstLine[2].StartsWith("HTTP/1.", StringComparison.Ordinal) ||
                !firstLine[1].StartsWith("/", StringComparison.Ordinal))
                throw new ApiError(400, "Invalid HTTP request line.");

            HeaderBag headers = new HeaderBag();
            for (int i = 1; i < lines.Length && lines[i].Length > 0; i++)
            {
                int separator = lines[i].IndexOf(':');
                if (separator <= 0) throw new ApiError(400, "Invalid HTTP header.");
                string name = lines[i].Substring(0, separator).Trim();
                string value = lines[i].Substring(separator + 1).Trim();
                if (!Regex.IsMatch(name, "^[A-Za-z0-9-]+$"))
                    throw new ApiError(400, "Invalid HTTP header name.");
                headers.Add(name, value);
            }
            if (headers.Count("Host") != 1 || headers.Count("Content-Length") > 1)
                throw new ApiError(400, "Invalid Host or Content-Length header.");
            if (!String.IsNullOrWhiteSpace(headers["Transfer-Encoding"]))
                throw new ApiError(501, "Transfer encoding is not supported.");
            string host = headers["Host"];
            if (host.IndexOf('/') >= 0 || host.IndexOf('\\') >= 0 || host.IndexOf('@') >= 0)
                throw new ApiError(400, "Invalid Host header.");
            Uri url;
            if (!Uri.TryCreate("http://" + host + firstLine[1], UriKind.Absolute, out url))
                throw new ApiError(400, "Invalid request URL.");

            int contentLength = 0;
            if (!String.IsNullOrWhiteSpace(headers["Content-Length"]) &&
                (!Int32.TryParse(headers["Content-Length"], NumberStyles.None, CultureInfo.InvariantCulture,
                    out contentLength) || contentLength < 0 || contentLength > 1024 * 1024))
                throw new ApiError(413, "Request body is too large.");
            byte[] body = new byte[contentLength];
            int position = 0;
            while (position < contentLength)
            {
                int count = input.Read(body, position, contentLength - position);
                if (count <= 0) throw new ApiError(400, "Incomplete request body.");
                position += count;
            }

            WebRequest request = new WebRequest();
            request.HttpMethod = firstLine[0];
            request.Url = url;
            request.Headers = headers;
            request.InputStream = new MemoryStream(body, false);
            request.RemoteEndPoint = remote;
            request.Cookies = new Dictionary<string, string>(StringComparer.Ordinal);
            string cookieHeader = headers["Cookie"];
            if (!String.IsNullOrWhiteSpace(cookieHeader))
            {
                foreach (string part in cookieHeader.Split(';'))
                {
                    int separator = part.IndexOf('=');
                    if (separator <= 0) continue;
                    request.Cookies[part.Substring(0, separator).Trim()] =
                        part.Substring(separator + 1).Trim();
                }
            }
            return request;
        }
    }

    internal sealed class WebResponse
    {
        private readonly NetworkStream Network;
        private bool Closed;
        public HeaderBag Headers { get; private set; }
        public int StatusCode { get; set; }
        public string ContentType { get; set; }
        public Encoding ContentEncoding { get; set; }
        public long ContentLength64 { get; set; }
        public Stream OutputStream { get; private set; }
        public WebResponse(NetworkStream network)
        {
            Network = network;
            Headers = new HeaderBag();
            StatusCode = 200;
            ContentLength64 = -1;
            OutputStream = new MemoryStream();
        }
        public void AppendHeader(string name, string value) { Headers.Add(name, value); }
        public void Redirect(string location)
        {
            StatusCode = 302;
            Headers["Location"] = location;
        }
        public void Close()
        {
            if (Closed) return;
            Closed = true;
            byte[] body = ((MemoryStream)OutputStream).ToArray();
            long length = ContentLength64 >= 0 ? ContentLength64 : body.Length;
            StringBuilder response = new StringBuilder();
            response.Append("HTTP/1.1 ").Append(StatusCode).Append(' ').Append(Reason(StatusCode)).Append("\r\n");
            response.Append("Connection: close\r\n");
            response.Append("Content-Length: ").Append(length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            if (!String.IsNullOrWhiteSpace(ContentType))
                response.Append("Content-Type: ").Append(ContentType).Append("\r\n");
            foreach (KeyValuePair<string, string> header in Headers.All())
                response.Append(header.Key).Append(": ").Append(header.Value).Append("\r\n");
            response.Append("\r\n");
            byte[] preamble = Encoding.ASCII.GetBytes(response.ToString());
            Network.Write(preamble, 0, preamble.Length);
            if (body.Length > 0) Network.Write(body, 0, body.Length);
            Network.Flush();
        }
        private static string Reason(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 302: return "Found";
                case 400: return "Bad Request";
                case 401: return "Unauthorized";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 405: return "Method Not Allowed";
                case 409: return "Conflict";
                case 413: return "Payload Too Large";
                case 415: return "Unsupported Media Type";
                case 429: return "Too Many Requests";
                case 431: return "Request Header Fields Too Large";
                case 500: return "Internal Server Error";
                case 501: return "Not Implemented";
                default: return "Error";
            }
        }
    }

    internal sealed class WebContext
    {
        public WebRequest Request { get; private set; }
        public WebResponse Response { get; private set; }
        public WebContext(WebRequest request, WebResponse response)
        {
            Request = request;
            Response = response;
        }
    }

    internal static class Program
    {
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, DateTime> AdminSessions = new Dictionary<string, DateTime>();
        private static readonly Dictionary<string, LoginState> LoginAttempts = new Dictionary<string, LoginState>();
        private static AppData Data;
        private static string Root;
        private static string DataFile;
        private static string AdminPasswordHash;

        private static void Main()
        {
            try
            {
                Root = Environment.GetEnvironmentVariable("EXAM_APP_ROOT");
                if (String.IsNullOrWhiteSpace(Root)) Root = Directory.GetCurrentDirectory();
                Root = Path.GetFullPath(Root);
                DataFile = Path.Combine(Root, "data", "exam-data.json");

                string password = Environment.GetEnvironmentVariable("EXAM_ADMIN_PASSWORD");
                if (String.IsNullOrEmpty(password) || password.Length < 12)
                    throw new InvalidOperationException("Set EXAM_ADMIN_PASSWORD to at least 12 characters before starting the server.");
                AdminPasswordHash = Hash(password);
                LoadData();

                string url = Environment.GetEnvironmentVariable("EXAM_URL");
                if (String.IsNullOrWhiteSpace(url)) url = "http://127.0.0.1:8787/";
                if (!url.EndsWith("/", StringComparison.Ordinal)) url += "/";
                Uri address;
                if (!Uri.TryCreate(url, UriKind.Absolute, out address) || address.Scheme != "http" ||
                    address.AbsolutePath != "/")
                    throw new InvalidOperationException("EXAM_URL must be an HTTP base URL such as http://127.0.0.1:8787/.");
                IPAddress bindAddress = address.Host == "localhost" || address.Host == "127.0.0.1"
                    ? IPAddress.Loopback : IPAddress.Any;
                TcpListener listener = new TcpListener(bindAddress, address.Port);
                listener.Start(100);
                Console.WriteLine("Exam server listening at " + url);
                Console.WriteLine("Applicant link: " + url + "exam");
                Console.WriteLine("Admin link:     " + url + "admin");
                Console.WriteLine("Press Ctrl+C to stop.");

                while (true)
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Server could not start: " + ex);
                Environment.ExitCode = 1;
            }
        }

        private static void HandleClient(object state)
        {
            using (TcpClient client = (TcpClient)state)
            {
                try
                {
                    client.ReceiveTimeout = 15000;
                    client.SendTimeout = 15000;
                    NetworkStream network = client.GetStream();
                    BufferedStream input = new BufferedStream(network, 8192);
                    WebResponse response = new WebResponse(network);
                    try
                    {
                        WebRequest request = WebRequest.Read(input, client.Client.RemoteEndPoint as IPEndPoint);
                        Handle(new WebContext(request, response));
                    }
                    catch (ApiError ex)
                    {
                        AddSecurityHeaders(response);
                        TrySendJson(response, ex.StatusCode, Json(new { error = ex.Message }));
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine(DateTime.UtcNow.ToString("o") + " " + ex);
                        AddSecurityHeaders(response);
                        TrySendJson(response, 500, Json(new { error = "An unexpected server error occurred." }));
                    }
                }
                catch (IOException) { }
                catch (SocketException) { }
            }
        }

        private static void LoadData()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(DataFile));
            JavaScriptSerializer serializer = NewSerializer();
            if (File.Exists(DataFile))
            {
                Data = serializer.Deserialize<AppData>(File.ReadAllText(DataFile, Encoding.UTF8));
                if (Data == null) throw new InvalidOperationException("The exam data file is empty or invalid.");
                if (Data.questions == null) Data.questions = new List<Question>();
                if (Data.attempts == null) Data.attempts = new List<Attempt>();
                foreach (Attempt attempt in Data.attempts)
                {
                    if (attempt.answers == null) attempt.answers = new Dictionary<string, int>();
                    if (attempt.questions == null) attempt.questions = new List<Question>();
                }
                if (Data.durationSeconds < 60) Data.durationSeconds = 3600;
                if (Data.passPercent < 0 || Data.passPercent > 100) Data.passPercent = 65;
                if (String.IsNullOrWhiteSpace(Data.status)) Data.status = "waiting";
                return;
            }

            string seedFile = Path.Combine(Root, "data", "seed-questions.json");
            if (!File.Exists(seedFile))
                throw new InvalidOperationException("Missing data/seed-questions.json. Add the question seed before starting.");
            List<Question> seed = serializer.Deserialize<List<Question>>(File.ReadAllText(seedFile, Encoding.UTF8));
            if (seed == null || seed.Count == 0)
                throw new InvalidOperationException("The question seed is empty.");

            HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Question question in seed)
            {
                if (question == null) throw new InvalidOperationException("The question seed contains an invalid entry.");
                if (String.IsNullOrWhiteSpace(question.id) || ids.Contains(question.id))
                    question.id = Guid.NewGuid().ToString("N");
                ids.Add(question.id);
                if (question.options == null) question.options = new List<string>();
                if (String.IsNullOrWhiteSpace(question.section)) question.section = "General";
                question.enabled = question.correctIndex.HasValue &&
                    question.correctIndex.Value >= 0 && question.correctIndex.Value < question.options.Count;
            }
            Data = new AppData();
            Data.status = "waiting";
            Data.durationSeconds = 3600;
            Data.passPercent = 65;
            Data.questions = seed;
            SaveData();
        }

        private static JavaScriptSerializer NewSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 16 * 1024 * 1024;
            serializer.RecursionLimit = 100;
            return serializer;
        }

        private static string Json(object value) { return NewSerializer().Serialize(value); }

        private static void SaveData()
        {
            string temporary = DataFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, Json(Data), Encoding.UTF8);
            Exception lastError = null;
            for (int attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    if (File.Exists(DataFile)) File.Replace(temporary, DataFile, null);
                    else File.Move(temporary, DataFile);
                    return;
                }
                catch (IOException ex) { lastError = ex; }
                catch (UnauthorizedAccessException ex) { lastError = ex; }
                Thread.Sleep(50 * (attempt + 1));
            }
            throw new IOException("Could not save exam data after multiple attempts.", lastError);
        }

        private static void Handle(WebContext context)
        {
            try
            {
                AddSecurityHeaders(context.Response);
                string path = Uri.UnescapeDataString(context.Request.Url.AbsolutePath).TrimEnd('/');
                if (path.Length == 0) path = "/";
                if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
                {
                    string response;
                    lock (Gate)
                    {
                        ExpireAttempts();
                        response = Json(RouteApi(context, path));
                    }
                    SendJson(context.Response, 200, response);
                    return;
                }
                ServeStatic(context, path);
            }
            catch (ApiError ex) { TrySendJson(context.Response, ex.StatusCode, Json(new { error = ex.Message })); }
            catch (Exception ex)
            {
                Console.Error.WriteLine(DateTime.UtcNow.ToString("o") + " " + ex);
                TrySendJson(context.Response, 500, Json(new { error = "An unexpected server error occurred." }));
            }
        }

        private static void AddSecurityHeaders(WebResponse response)
        {
            response.Headers["X-Content-Type-Options"] = "nosniff";
            response.Headers["X-Frame-Options"] = "DENY";
            response.Headers["Referrer-Policy"] = "no-referrer";
            response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
            response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
            response.Headers["Cache-Control"] = "no-store";
        }

        private static void SendJson(WebResponse response, int status, string json)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            response.StatusCode = status;
            response.ContentType = "application/json; charset=utf-8";
            response.ContentEncoding = Encoding.UTF8;
            response.ContentLength64 = bytes.Length;
            response.OutputStream.Write(bytes, 0, bytes.Length);
            response.Close();
        }

        private static void TrySendJson(WebResponse response, int status, string json)
        {
            try { SendJson(response, status, json); }
            catch { try { response.Close(); } catch { } }
        }

        private static void ServeStatic(WebContext context, string path)
        {
            if (context.Request.HttpMethod != "GET" && context.Request.HttpMethod != "HEAD")
                throw new ApiError(405, "Method not allowed.");
            if (path == "/")
            {
                context.Response.Redirect("/exam");
                context.Response.Close();
                return;
            }
            if (path == "/exam") path = "/exam.html";
            if (path == "/admin") path = "/admin.html";

            string publicRoot = Path.GetFullPath(Path.Combine(Root, "public"));
            string relative = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            string file = Path.GetFullPath(Path.Combine(publicRoot, relative));
            if (!file.StartsWith(publicRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                !File.Exists(file))
                throw new ApiError(404, "Page not found.");

            string extension = Path.GetExtension(file).ToLowerInvariant();
            string contentType = "application/octet-stream";
            if (extension == ".html") contentType = "text/html; charset=utf-8";
            else if (extension == ".css") contentType = "text/css; charset=utf-8";
            else if (extension == ".js") contentType = "text/javascript; charset=utf-8";
            else if (extension == ".svg") contentType = "image/svg+xml";
            else if (extension == ".png") contentType = "image/png";
            else if (extension == ".ico") contentType = "image/x-icon";
            else throw new ApiError(404, "Page not found.");

            byte[] bytes = File.ReadAllBytes(file);
            context.Response.StatusCode = 200;
            context.Response.ContentType = contentType;
            context.Response.ContentLength64 = bytes.Length;
            if (context.Request.HttpMethod == "GET") context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.Close();
        }

        private static object RouteApi(WebContext context, string path)
        {
            WebRequest request = context.Request;
            string method = request.HttpMethod.ToUpperInvariant();
            if (method != "GET") CheckOrigin(request);

            if (path == "/api/candidate/state" && method == "GET")
                return CandidateState(FindCandidate(request));
            if (path == "/api/candidate/register" && method == "POST")
                return RegisterCandidate(context, ReadBody(request));
            if (path == "/api/candidate/start" && method == "POST")
                return StartCandidate(request);
            if (path == "/api/candidate/answer" && method == "PUT")
                return SaveAnswer(request, ReadBody(request));
            if (path == "/api/candidate/submit" && method == "POST")
                return SubmitCandidate(request);

            if (path == "/api/admin/login" && method == "POST")
                return AdminLogin(context, ReadBody(request));
            if (path == "/api/admin/logout" && method == "POST")
                return AdminLogout(context);

            if (path.StartsWith("/api/admin/", StringComparison.Ordinal)) RequireAdmin(request);
            if (path == "/api/admin/overview" && method == "GET") return AdminOverview();
            if (path == "/api/admin/control" && method == "POST") return AdminControl(ReadBody(request));
            if (path == "/api/admin/settings" && method == "PUT") return AdminSettings(ReadBody(request));
            if (path == "/api/admin/timer/adjust" && method == "POST") return AdminAdjustTimer(ReadBody(request));
            if (path == "/api/admin/questions" && method == "GET") return new { questions = Data.questions };
            if (path == "/api/admin/questions" && method == "POST") return AdminCreateQuestion(ReadBody(request));
            if (path.StartsWith("/api/admin/questions/", StringComparison.Ordinal) && method == "PUT")
                return AdminUpdateQuestion(path.Substring("/api/admin/questions/".Length), ReadBody(request));
            if (path.StartsWith("/api/admin/results/", StringComparison.Ordinal) && method == "GET")
                return AdminResultDetail(path.Substring("/api/admin/results/".Length));

            throw new ApiError(404, "Endpoint not found.");
        }

        private static void CheckOrigin(WebRequest request)
        {
            string origin = request.Headers["Origin"];
            Uri originUri;
            if (String.IsNullOrWhiteSpace(origin) || !Uri.TryCreate(origin, UriKind.Absolute, out originUri) ||
                (originUri.Scheme != "http" && originUri.Scheme != "https") ||
                !String.Equals(originUri.Authority, request.Headers["Host"], StringComparison.OrdinalIgnoreCase))
                throw new ApiError(403, "Request origin is not allowed.");
        }

        private static Dictionary<string, object> ReadBody(WebRequest request)
        {
            if (request.ContentType == null || !request.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                throw new ApiError(415, "Send a JSON request body.");
            MemoryStream memory = new MemoryStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = request.InputStream.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (memory.Length + read > 1024 * 1024) throw new ApiError(413, "Request body is too large.");
                memory.Write(buffer, 0, read);
            }
            try
            {
                object parsed = NewSerializer().DeserializeObject(Encoding.UTF8.GetString(memory.ToArray()));
                Dictionary<string, object> body = parsed as Dictionary<string, object>;
                if (body == null) throw new ApiError(400, "JSON body must be an object.");
                return body;
            }
            catch (ArgumentException) { throw new ApiError(400, "Invalid JSON body."); }
        }

        private static string RequiredString(Dictionary<string, object> body, string key, int maxLength)
        {
            object value;
            if (!body.TryGetValue(key, out value) || value == null || !(value is string))
                throw new ApiError(400, key + " is required.");
            string result = ((string)value).Trim();
            if (result.Length == 0 || result.Length > maxLength)
                throw new ApiError(400, key + " has an invalid length.");
            foreach (char character in result)
                if (Char.IsControl(character)) throw new ApiError(400, key + " contains an invalid character.");
            return result;
        }

        private static int RequiredInt(Dictionary<string, object> body, string key)
        {
            object value;
            if (!body.TryGetValue(key, out value) || value == null)
                throw new ApiError(400, key + " is required.");
            try
            {
                double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (Double.IsNaN(number) || Double.IsInfinity(number) || Math.Floor(number) != number ||
                    number < Int32.MinValue || number > Int32.MaxValue)
                    throw new ApiError(400, key + " must be a whole number.");
                return (int)number;
            }
            catch (FormatException) { throw new ApiError(400, key + " must be a whole number."); }
            catch (InvalidCastException) { throw new ApiError(400, key + " must be a whole number."); }
        }

        private static bool RequiredBool(Dictionary<string, object> body, string key)
        {
            object value;
            if (!body.TryGetValue(key, out value) || !(value is bool))
                throw new ApiError(400, key + " must be true or false.");
            return (bool)value;
        }

        private static string IsoNow() { return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture); }

        private static DateTime ParseUtc(string value)
        {
            return DateTime.Parse(value, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind).ToUniversalTime();
        }

        private static string Hash(string value)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
                StringBuilder result = new StringBuilder(digest.Length * 2);
                foreach (byte b in digest) result.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return result.ToString();
            }
        }

        private static bool EqualHash(string first, string second)
        {
            if (first == null || second == null || first.Length != second.Length) return false;
            int difference = 0;
            for (int i = 0; i < first.Length; i++) difference |= first[i] ^ second[i];
            return difference == 0;
        }

        private static string NewToken()
        {
            byte[] bytes = new byte[32];
            using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static string GetCookie(WebRequest request, string name)
        {
            string value;
            return request.Cookies.TryGetValue(name, out value) ? value : null;
        }

        private static void SetCookie(WebContext context, string name, string value, int maxAgeSeconds)
        {
            string cookie = name + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
                maxAgeSeconds.ToString(CultureInfo.InvariantCulture);
            if (context.Request.IsSecureConnection ||
                String.Equals(context.Request.Headers["X-Forwarded-Proto"], "https", StringComparison.OrdinalIgnoreCase))
                cookie += "; Secure";
            context.Response.AppendHeader("Set-Cookie", cookie);
        }

        private static Attempt FindCandidate(WebRequest request)
        {
            string token = GetCookie(request, "applicant_session");
            if (String.IsNullOrWhiteSpace(token)) return null;
            string tokenHash = Hash(token);
            foreach (Attempt attempt in Data.attempts)
                if (EqualHash(attempt.tokenHash, tokenHash)) return attempt;
            return null;
        }

        private static Attempt RequireCandidate(WebRequest request)
        {
            Attempt attempt = FindCandidate(request);
            if (attempt == null) throw new ApiError(401, "Please register before starting the exam.");
            return attempt;
        }

        private static object ExamView()
        {
            int count = 0;
            foreach (Question question in Data.questions) if (question.enabled) count++;
            return new { status = Data.status, durationSeconds = Data.durationSeconds, questionCount = count };
        }

        private static int SecondsRemaining(Attempt attempt)
        {
            if (attempt.status == "registered") return Data.durationSeconds;
            if (attempt.status != "active" || String.IsNullOrWhiteSpace(attempt.deadlineAtUtc)) return 0;
            DateTime clock = Data.status == "paused" && !String.IsNullOrWhiteSpace(Data.pauseStartedAtUtc)
                ? ParseUtc(Data.pauseStartedAtUtc) : DateTime.UtcNow;
            return Math.Max(0, (int)Math.Ceiling((ParseUtc(attempt.deadlineAtUtc) - clock).TotalSeconds));
        }

        private static bool ExpireAttempts()
        {
            bool changed = false;
            foreach (Attempt attempt in Data.attempts)
            {
                if (attempt.status == "active" && SecondsRemaining(attempt) <= 0)
                {
                    CompleteAttempt(attempt, "expired");
                    changed = true;
                }
            }
            if (changed) SaveData();
            return changed;
        }

        private static object CandidateState(Attempt attempt)
        {
            if (attempt == null) return new { authenticated = false, exam = ExamView() };
            List<object> questions = new List<object>();
            if (attempt.status == "active")
            {
                foreach (Question question in attempt.questions)
                    questions.Add(new { id = question.id, section = question.section,
                        text = question.text, options = question.options });
            }
            string ic = attempt.ic == null ? "" : attempt.ic;
            string masked = new string('\u2022', Math.Max(0, ic.Length - 4)) +
                ic.Substring(Math.Max(0, ic.Length - 4));
            return new
            {
                authenticated = true,
                exam = ExamView(),
                attempt = new
                {
                    id = attempt.id,
                    name = attempt.name,
                    icMasked = masked,
                    status = attempt.status,
                    startedAtUtc = attempt.startedAtUtc,
                    submittedAtUtc = attempt.submittedAtUtc,
                    secondsRemaining = SecondsRemaining(attempt),
                    answers = new Dictionary<string, int>(attempt.answers),
                    questions = questions
                }
            };
        }

        private static object RegisterCandidate(WebContext context, Dictionary<string, object> body)
        {
            Attempt existingSession = FindCandidate(context.Request);
            if (existingSession != null) return CandidateState(existingSession);
            if (Data.status == "closed")
                throw new ApiError(409, "Registration is closed. Please contact the administrator.");

            string name = RequiredString(body, "name", 120);
            string ic = RequiredString(body, "ic", 32);
            if (name.Length < 2) throw new ApiError(400, "Please enter your full name.");
            if (!Regex.IsMatch(ic, "^[A-Za-z0-9 -]{6,32}$"))
                throw new ApiError(400, "IC must contain 6 to 32 letters, digits, spaces, or hyphens.");
            string normalizedIc = NormalizeIc(ic);
            foreach (Attempt attempt in Data.attempts)
                if (NormalizeIc(attempt.ic) == normalizedIc)
                    throw new ApiError(409, "This IC is already registered. Ask the administrator for help if you changed browsers.");

            string token = NewToken();
            Attempt created = new Attempt();
            created.id = Guid.NewGuid().ToString("N");
            created.name = name;
            created.ic = ic;
            created.tokenHash = Hash(token);
            created.status = "registered";
            created.registeredAtUtc = IsoNow();
            Data.attempts.Add(created);
            SaveData();
            SetCookie(context, "applicant_session", token, 60 * 60 * 24 * 30);
            return CandidateState(created);
        }

        private static string NormalizeIc(string ic)
        {
            return (ic ?? "").Replace(" ", "").Replace("-", "").ToUpperInvariant();
        }

        private static Question CopyQuestion(Question source)
        {
            Question copy = new Question();
            copy.id = source.id;
            copy.section = source.section;
            copy.text = source.text;
            copy.options = new List<string>(source.options);
            copy.correctIndex = source.correctIndex;
            copy.enabled = source.enabled;
            copy.explanation = source.explanation;
            return copy;
        }

        private static void ShuffleQuestions(List<Question> questions)
        {
            using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
            {
                byte[] bytes = new byte[4];
                for (int i = questions.Count - 1; i > 0; i--)
                {
                    generator.GetBytes(bytes);
                    int j = (int)(BitConverter.ToUInt32(bytes, 0) % (uint)(i + 1));
                    Question value = questions[i];
                    questions[i] = questions[j];
                    questions[j] = value;
                }
            }
        }

        private static object StartCandidate(WebRequest request)
        {
            Attempt attempt = RequireCandidate(request);
            if (attempt.status == "active") return CandidateState(attempt);
            if (attempt.status != "registered") throw new ApiError(409, "This attempt is already complete.");
            if (Data.status != "open") throw new ApiError(409, "The administrator has not opened the exam.");
            List<Question> selected = new List<Question>();
            foreach (Question question in Data.questions)
                if (question.enabled && question.correctIndex.HasValue && question.options != null &&
                    question.correctIndex.Value >= 0 && question.correctIndex.Value < question.options.Count)
                    selected.Add(CopyQuestion(question));
            if (selected.Count == 0) throw new ApiError(409, "No graded questions are available yet.");
            ShuffleQuestions(selected);
            attempt.questions = selected;
            attempt.answers = new Dictionary<string, int>();
            attempt.status = "active";
            DateTime now = DateTime.UtcNow;
            attempt.startedAtUtc = now.ToString("o", CultureInfo.InvariantCulture);
            attempt.deadlineAtUtc = now.AddSeconds(Data.durationSeconds).ToString("o", CultureInfo.InvariantCulture);
            SaveData();
            return CandidateState(attempt);
        }

        private static object SaveAnswer(WebRequest request, Dictionary<string, object> body)
        {
            Attempt attempt = RequireCandidate(request);
            if (attempt.status != "active") throw new ApiError(409, "This attempt is not active.");
            if (Data.status != "open") throw new ApiError(409, "The exam is paused or closed.");
            string questionId = RequiredString(body, "questionId", 100);
            int optionIndex = RequiredInt(body, "optionIndex");
            Question matched = null;
            foreach (Question question in attempt.questions)
                if (question.id == questionId) { matched = question; break; }
            if (matched == null || optionIndex < 0 || optionIndex >= matched.options.Count)
                throw new ApiError(400, "Invalid question or answer.");
            attempt.answers[questionId] = optionIndex;
            SaveData();
            return new { ok = true, secondsRemaining = SecondsRemaining(attempt),
                answers = new Dictionary<string, int>(attempt.answers) };
        }

        private static object SubmitCandidate(WebRequest request)
        {
            Attempt attempt = RequireCandidate(request);
            if (attempt.status == "registered") throw new ApiError(409, "The exam has not started.");
            if (attempt.status == "active")
            {
                CompleteAttempt(attempt, "submitted");
                SaveData();
            }
            return CandidateState(attempt);
        }

        private static void CompleteAttempt(Attempt attempt, string status)
        {
            int correct = 0;
            foreach (Question question in attempt.questions)
            {
                int selected;
                if (question.correctIndex.HasValue && attempt.answers.TryGetValue(question.id, out selected) &&
                    selected == question.correctIndex.Value) correct++;
            }
            int count = attempt.questions.Count;
            attempt.score = correct;
            attempt.percentage = count == 0 ? 0 : Math.Round(100.0 * correct / count, 1, MidpointRounding.AwayFromZero);
            attempt.pass = count > 0 && correct * 100 >= Data.passPercent * count;
            attempt.passPercentAtSubmission = Data.passPercent;
            attempt.status = status;
            attempt.submittedAtUtc = IsoNow();
        }

        private static object AdminLogin(WebContext context, Dictionary<string, object> body)
        {
            string address = context.Request.RemoteEndPoint == null ? "unknown" :
                context.Request.RemoteEndPoint.Address.ToString();
            LoginState state;
            if (!LoginAttempts.TryGetValue(address, out state))
            {
                state = new LoginState();
                LoginAttempts[address] = state;
            }
            if (state.BlockedUntilUtc > DateTime.UtcNow)
                throw new ApiError(429, "Too many login attempts. Please try again in five minutes.");
            string password = RequiredString(body, "password", 1024);
            if (!EqualHash(Hash(password), AdminPasswordHash))
            {
                state.Failures++;
                if (state.Failures >= 5)
                {
                    state.Failures = 0;
                    state.BlockedUntilUtc = DateTime.UtcNow.AddMinutes(5);
                }
                throw new ApiError(401, "Incorrect admin password.");
            }
            LoginAttempts.Remove(address);
            string token = NewToken();
            AdminSessions[Hash(token)] = DateTime.UtcNow.AddHours(12);
            SetCookie(context, "admin_session", token, 12 * 60 * 60);
            return new { ok = true };
        }

        private static void RequireAdmin(WebRequest request)
        {
            string token = GetCookie(request, "admin_session");
            DateTime expires;
            if (String.IsNullOrWhiteSpace(token) || !AdminSessions.TryGetValue(Hash(token), out expires) ||
                expires <= DateTime.UtcNow)
                throw new ApiError(401, "Please sign in as administrator.");
        }

        private static object AdminLogout(WebContext context)
        {
            string token = GetCookie(context.Request, "admin_session");
            if (!String.IsNullOrWhiteSpace(token)) AdminSessions.Remove(Hash(token));
            SetCookie(context, "admin_session", "", 0);
            return new { ok = true };
        }

        private static object ResultRow(Attempt attempt)
        {
            return new
            {
                id = attempt.id,
                name = attempt.name,
                ic = attempt.ic,
                status = attempt.status,
                score = attempt.score,
                questionCount = attempt.questions.Count,
                percentage = attempt.percentage,
                pass = attempt.pass,
                startedAtUtc = attempt.startedAtUtc,
                submittedAtUtc = attempt.submittedAtUtc,
                secondsRemaining = SecondsRemaining(attempt)
            };
        }

        private static object AdminOverview()
        {
            int waiting = 0, active = 0, submitted = 0, graded = 0;
            foreach (Question question in Data.questions) if (question.enabled) graded++;
            List<Attempt> sorted = new List<Attempt>(Data.attempts);
            sorted.Sort(delegate(Attempt first, Attempt second)
            {
                return String.Compare(second.registeredAtUtc, first.registeredAtUtc, StringComparison.Ordinal);
            });
            List<object> results = new List<object>();
            foreach (Attempt attempt in sorted)
            {
                if (attempt.status == "registered") waiting++;
                else if (attempt.status == "active") active++;
                else submitted++;
                results.Add(ResultRow(attempt));
            }
            return new
            {
                status = Data.status,
                durationSeconds = Data.durationSeconds,
                passPercent = Data.passPercent,
                questionCount = graded,
                waitingCount = waiting,
                activeCount = active,
                submittedCount = submitted,
                results = results
            };
        }

        private static object AdminControl(Dictionary<string, object> body)
        {
            string action = RequiredString(body, "action", 30).ToLowerInvariant();
            if (action == "open")
            {
                if (Data.status == "paused") ResumeExam();
                else
                {
                    int count = 0;
                    foreach (Question question in Data.questions) if (question.enabled) count++;
                    if (count == 0) throw new ApiError(409, "Set an answer key and enable at least one question first.");
                    Data.status = "open";
                }
            }
            else if (action == "pause")
            {
                if (Data.status != "open") throw new ApiError(409, "The exam is not open.");
                Data.status = "paused";
                Data.pauseStartedAtUtc = IsoNow();
            }
            else if (action == "resume")
            {
                if (Data.status != "paused") throw new ApiError(409, "The exam is not paused.");
                ResumeExam();
            }
            else if (action == "finish")
            {
                if (Data.status != "closed")
                {
                    foreach (Attempt attempt in Data.attempts)
                        if (attempt.status == "active") CompleteAttempt(attempt, "finished_by_admin");
                    Data.status = "closed";
                    Data.pauseStartedAtUtc = null;
                }
            }
            else throw new ApiError(400, "Unknown exam control action.");
            SaveData();
            return AdminOverview();
        }

        private static void ResumeExam()
        {
            DateTime pausedAt = ParseUtc(Data.pauseStartedAtUtc);
            TimeSpan pause = DateTime.UtcNow - pausedAt;
            foreach (Attempt attempt in Data.attempts)
                if (attempt.status == "active")
                    attempt.deadlineAtUtc = ParseUtc(attempt.deadlineAtUtc).Add(pause)
                        .ToString("o", CultureInfo.InvariantCulture);
            Data.pauseStartedAtUtc = null;
            Data.status = "open";
        }

        private static object AdminSettings(Dictionary<string, object> body)
        {
            if (!body.ContainsKey("durationMinutes") && !body.ContainsKey("passPercent"))
                throw new ApiError(400, "No settings were supplied.");
            if (body.ContainsKey("durationMinutes"))
            {
                int minutes = RequiredInt(body, "durationMinutes");
                if (minutes < 1 || minutes > 180) throw new ApiError(400, "Duration must be 1 to 180 minutes.");
                int nextSeconds = minutes * 60;
                int difference = nextSeconds - Data.durationSeconds;
                foreach (Attempt attempt in Data.attempts)
                    if (attempt.status == "active")
                        attempt.deadlineAtUtc = ParseUtc(attempt.deadlineAtUtc).AddSeconds(difference)
                            .ToString("o", CultureInfo.InvariantCulture);
                Data.durationSeconds = nextSeconds;
            }
            if (body.ContainsKey("passPercent"))
            {
                int percent = RequiredInt(body, "passPercent");
                if (percent < 0 || percent > 100) throw new ApiError(400, "Pass mark must be 0 to 100 percent.");
                Data.passPercent = percent;
            }
            ExpireAttempts();
            SaveData();
            return AdminOverview();
        }

        private static object AdminAdjustTimer(Dictionary<string, object> body)
        {
            int minutes = RequiredInt(body, "minutes");
            if (minutes == 0 || minutes < -180 || minutes > 180)
                throw new ApiError(400, "Adjustment must be between -180 and 180 minutes, excluding zero.");
            string candidateId = null;
            object rawId;
            if (body.TryGetValue("candidateId", out rawId) && rawId != null)
                candidateId = Convert.ToString(rawId, CultureInfo.InvariantCulture);
            int changed = 0;
            foreach (Attempt attempt in Data.attempts)
            {
                if (attempt.status != "active" ||
                    (!String.IsNullOrWhiteSpace(candidateId) && attempt.id != candidateId)) continue;
                attempt.deadlineAtUtc = ParseUtc(attempt.deadlineAtUtc).AddMinutes(minutes)
                    .ToString("o", CultureInfo.InvariantCulture);
                changed++;
            }
            if (changed == 0) throw new ApiError(409, "No active attempts match this adjustment.");
            ExpireAttempts();
            SaveData();
            return AdminOverview();
        }

        private static Question ParseQuestion(Dictionary<string, object> body, string id, string previousExplanation)
        {
            Question question = new Question();
            question.id = id;
            question.section = RequiredString(body, "section", 100);
            question.text = RequiredString(body, "text", 3000);
            if (question.text.Length < 8) throw new ApiError(400, "Question text is too short.");
            object rawOptions;
            if (!body.TryGetValue("options", out rawOptions) || !(rawOptions is IEnumerable) || rawOptions is string)
                throw new ApiError(400, "Provide answer options.");
            foreach (object value in (IEnumerable)rawOptions)
            {
                string option = value as string;
                if (option == null) throw new ApiError(400, "Options must be text.");
                option = option.Trim();
                if (option.Length == 0 || option.Length > 1000)
                    throw new ApiError(400, "An answer option has an invalid length.");
                question.options.Add(option);
            }
            if (question.options.Count < 2 || question.options.Count > 6)
                throw new ApiError(400, "A question needs 2 to 6 options.");
            object rawCorrect;
            if (body.TryGetValue("correctIndex", out rawCorrect) && rawCorrect != null)
                question.correctIndex = RequiredInt(body, "correctIndex");
            else question.correctIndex = null;
            question.enabled = RequiredBool(body, "enabled");
            if (question.correctIndex.HasValue &&
                (question.correctIndex.Value < 0 || question.correctIndex.Value >= question.options.Count))
                throw new ApiError(400, "Correct answer is outside the option list.");
            if (question.enabled && !question.correctIndex.HasValue)
                throw new ApiError(400, "Choose a correct answer before enabling this question.");
            question.explanation = previousExplanation;
            object explanation;
            if (body.TryGetValue("explanation", out explanation) && explanation is string)
                question.explanation = ((string)explanation).Trim();
            return question;
        }

        private static object AdminCreateQuestion(Dictionary<string, object> body)
        {
            Question question = ParseQuestion(body, Guid.NewGuid().ToString("N"), null);
            Data.questions.Add(question);
            SaveData();
            return new { question = question };
        }

        private static object AdminUpdateQuestion(string id, Dictionary<string, object> body)
        {
            for (int i = 0; i < Data.questions.Count; i++)
            {
                if (Data.questions[i].id != id) continue;
                Question updated = ParseQuestion(body, id, Data.questions[i].explanation);
                Data.questions[i] = updated;
                SaveData();
                return new { question = updated };
            }
            throw new ApiError(404, "Question not found.");
        }

        private static object AdminResultDetail(string id)
        {
            Attempt attempt = null;
            foreach (Attempt candidate in Data.attempts)
                if (candidate.id == id) { attempt = candidate; break; }
            if (attempt == null) throw new ApiError(404, "Applicant result not found.");
            List<object> answers = new List<object>();
            foreach (Question question in attempt.questions)
            {
                int selected;
                bool answered = attempt.answers.TryGetValue(question.id, out selected);
                answers.Add(new
                {
                    id = question.id,
                    section = question.section,
                    text = question.text,
                    options = question.options,
                    correctIndex = question.correctIndex,
                    selectedIndex = answered ? (int?)selected : null,
                    correct = answered && question.correctIndex.HasValue && selected == question.correctIndex.Value
                });
            }
            return new
            {
                attempt = new
                {
                    id = attempt.id,
                    name = attempt.name,
                    ic = attempt.ic,
                    status = attempt.status,
                    score = attempt.score,
                    questionCount = attempt.questions.Count,
                    percentage = attempt.percentage,
                    pass = attempt.pass,
                    startedAtUtc = attempt.startedAtUtc,
                    submittedAtUtc = attempt.submittedAtUtc,
                    passPercentAtSubmission = attempt.passPercentAtSubmission
                },
                answers = answers
            };
        }
    }
}
