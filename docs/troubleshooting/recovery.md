# Diagnosing Background Recovery Failures

## 1. Expected Recovery Log Sequence

When control-plane connectivity is restored after a startup outage, the following log sequence will be printed:

```text
[Pulse] INFO: SDK entering background recovery mode.
[Pulse] INFO: SDK recovery attempt #1.
[Pulse] INFO: [RemoteConfigClient] Control-plane request started {"endpoint":"/v1/init"}
[Pulse] INFO: [RemoteConfigClient] Control-plane response received {"endpoint":"/v1/init","statusCode":200,"ok":true}
[Pulse] INFO: SDK recovery succeeded. Telemetry is now fully initialized.
```

Once this sequence completes, the client is fully initialized and all telemetry routes are active.

---

## 2. Troubleshooting Persistent Recovery Loops

If recovery attempts continue indefinitely without succeeding:

### 2.1 Check for Permanent HTTP Status Codes
If the control plane responds with HTTP 401 or HTTP 403, recovery stops automatically:
```text
[Pulse] ERROR: Permanent authentication failure (HTTP 401). Recovery terminated.
```
- **Remediation:** Verify that your `PULSE_API_KEY` is valid and active.

### 2.2 Verify Endpoint Reachability
If the recovery worker continues retrying every 60 seconds:
- Ensure the container has unrestricted outbound HTTPS connectivity.
- Check firewall, VPC security group, or DNS egress rules.

### 2.3 Verify Process Liveness
- The recovery worker uses `.unref()` on its internal `setTimeout`. If your application has no active HTTP servers or open sockets, Node.js will exit cleanly without waiting for recovery to complete. This is intentional and expected.
