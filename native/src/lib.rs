use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

/// Global tokio runtime — shared across all calls.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .expect("Failed to create tokio runtime")
    })
}

/// Build a reqwest Client with optional proxy.
fn build_client(proxy_url: Option<&str>) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .http2_prior_knowledge() // prefer H2 like real codex-rs
        .pool_max_idle_per_host(4)
        .tcp_keepalive(Duration::from_secs(30));

    if let Some(url) = proxy_url {
        if !url.is_empty() {
            let proxy = reqwest::Proxy::all(url)
                .map_err(|e| Error::from_reason(format!("Invalid proxy URL: {e}")))?;
            builder = builder.proxy(proxy);
        }
    }

    builder
        .build()
        .map_err(|e| Error::from_reason(format!("Failed to build HTTP client: {e}")))
}

/// Convert JS headers object to reqwest HeaderMap.
fn to_header_map(headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut map = HeaderMap::with_capacity(headers.len());
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| Error::from_reason(format!("Invalid header name '{k}': {e}")))?;
        let value = HeaderValue::from_str(v)
            .map_err(|e| Error::from_reason(format!("Invalid header value for '{k}': {e}")))?;
        map.append(name, value);
    }
    Ok(map)
}

/// Extract Set-Cookie headers from response.
fn extract_set_cookie(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(String::from)
        .collect()
}

/// Convert response headers to a flat JS-friendly HashMap.
/// For duplicate headers (like set-cookie), joins with ", ".
fn headers_to_map(headers: &HeaderMap) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (name, value) in headers {
        let key = name.as_str().to_string();
        if let Ok(v) = value.to_str() {
            map.entry(key)
                .and_modify(|existing: &mut String| {
                    existing.push_str(", ");
                    existing.push_str(v);
                })
                .or_insert_with(|| v.to_string());
        }
    }
    map
}

// ─── GET ───────────────────────────────────────────────────────────

#[napi(object)]
pub struct GetResponse {
    pub status: u16,
    pub body: String,
    pub set_cookie_headers: Vec<String>,
}

#[napi]
pub fn http_get(
    url: String,
    headers: HashMap<String, String>,
    timeout_sec: Option<u32>,
    proxy_url: Option<String>,
) -> AsyncTask<GetTask> {
    AsyncTask::new(GetTask {
        url,
        headers,
        timeout_sec,
        proxy_url,
    })
}

pub struct GetTask {
    url: String,
    headers: HashMap<String, String>,
    timeout_sec: Option<u32>,
    proxy_url: Option<String>,
}

#[napi]
impl Task for GetTask {
    type Output = GetResponse;
    type JsValue = GetResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        runtime().block_on(async {
            let client = build_client(self.proxy_url.as_deref())?;
            let header_map = to_header_map(&self.headers)?;

            let mut req = client.get(&self.url).headers(header_map);
            if let Some(t) = self.timeout_sec {
                req = req.timeout(Duration::from_secs(t as u64));
            }

            let resp = req
                .send()
                .await
                .map_err(|e| Error::from_reason(format!("GET failed: {e}")))?;

            let status = resp.status().as_u16();
            let set_cookie_headers = extract_set_cookie(resp.headers());
            let body = resp
                .text()
                .await
                .map_err(|e| Error::from_reason(format!("Failed to read body: {e}")))?;

            Ok(GetResponse {
                status,
                body,
                set_cookie_headers,
            })
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

// ─── Simple POST ───────────────────────────────────────────────────

#[napi(object)]
pub struct PostResponse {
    pub status: u16,
    pub body: String,
}

#[napi]
pub fn http_post(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_sec: Option<u32>,
    proxy_url: Option<String>,
) -> AsyncTask<PostTask> {
    AsyncTask::new(PostTask {
        url,
        headers,
        body,
        timeout_sec,
        proxy_url,
    })
}

pub struct PostTask {
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_sec: Option<u32>,
    proxy_url: Option<String>,
}

#[napi]
impl Task for PostTask {
    type Output = PostResponse;
    type JsValue = PostResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        runtime().block_on(async {
            let client = build_client(self.proxy_url.as_deref())?;
            let header_map = to_header_map(&self.headers)?;

            let mut req = client.post(&self.url).headers(header_map).body(self.body.clone());
            if let Some(t) = self.timeout_sec {
                req = req.timeout(Duration::from_secs(t as u64));
            }

            let resp = req
                .send()
                .await
                .map_err(|e| Error::from_reason(format!("POST failed: {e}")))?;

            let status = resp.status().as_u16();
            let body = resp
                .text()
                .await
                .map_err(|e| Error::from_reason(format!("Failed to read body: {e}")))?;

            Ok(PostResponse { status, body })
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

// ─── Streaming POST ────────────────────────────────────────────────

#[napi(object)]
pub struct StreamMeta {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub set_cookie_headers: Vec<String>,
}

/// Streaming POST: sends the request, returns metadata immediately,
/// then pushes body chunks via the `on_chunk(err?, chunk?)` callback.
///
/// JS signature:
///   httpPostStream(url, headers, body, onChunk, proxyUrl?) → Promise<StreamMeta>
///
/// onChunk(null, Buffer)  — data chunk
/// onChunk(null, null)    — stream ended
/// onChunk(Error, null)   — stream error
#[napi]
pub fn http_post_stream(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    on_chunk: ThreadsafeFunction<Option<Buffer>, ErrorStrategy::Fatal>,
    proxy_url: Option<String>,
) -> AsyncTask<StreamPostTask> {
    AsyncTask::new(StreamPostTask {
        url,
        headers,
        body,
        on_chunk,
        proxy_url,
    })
}

pub struct StreamPostTask {
    url: String,
    headers: HashMap<String, String>,
    body: String,
    on_chunk: ThreadsafeFunction<Option<Buffer>, ErrorStrategy::Fatal>,
    proxy_url: Option<String>,
}

#[napi]
impl Task for StreamPostTask {
    type Output = StreamMeta;
    type JsValue = StreamMeta;

    fn compute(&mut self) -> Result<Self::Output> {
        use futures_util::StreamExt;

        runtime().block_on(async {
            let client = build_client(self.proxy_url.as_deref())?;
            let header_map = to_header_map(&self.headers)?;

            let resp = client
                .post(&self.url)
                .headers(header_map)
                .body(self.body.clone())
                .send()
                .await
                .map_err(|e| Error::from_reason(format!("Streaming POST failed: {e}")))?;

            let status = resp.status().as_u16();
            let resp_headers = headers_to_map(resp.headers());
            let set_cookie_headers = extract_set_cookie(resp.headers());
            let meta = StreamMeta {
                status,
                headers: resp_headers,
                set_cookie_headers,
            };

            // Spawn a task to stream body chunks to JS
            let on_chunk = self.on_chunk.clone();
            let mut stream = resp.bytes_stream();

            tokio::spawn(async move {
                while let Some(result) = stream.next().await {
                    match result {
                        Ok(bytes) => {
                            let buf: Buffer = bytes.to_vec().into();
                            on_chunk.call(
                                Some(buf),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                        Err(e) => {
                            eprintln!("[codex-tls] Stream read error: {e}");
                            break;
                        }
                    }
                }
                // Signal end of stream
                on_chunk.call(None, ThreadsafeFunctionCallMode::NonBlocking);
            });

            Ok(meta)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
