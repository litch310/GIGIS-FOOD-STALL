<?php
class EmailDeliveryException extends RuntimeException
{
}

function smtpReadResponse($socket): string
{
    $response = '';
    do {
        $line = fgets($socket, 515);
        if ($line === false) {
            throw new EmailDeliveryException('The email server ended the connection unexpectedly.');
        }
        $response = $line;
    } while (isset($line[3]) && $line[3] === '-');

    return $response;
}

function smtpWrite($socket, string $data): void
{
    $remaining = $data;
    while ($remaining !== '') {
        $written = fwrite($socket, $remaining);
        if ($written === false || $written === 0) {
            throw new EmailDeliveryException('Could not send a request to the email server.');
        }
        $remaining = substr($remaining, $written);
    }
}

function smtpCommand($socket, string $command, array $expected, string $stage): string
{
    try {
        smtpWrite($socket, $command . "\r\n");
        $response = smtpReadResponse($socket);
    } catch (EmailDeliveryException $e) {
        throw new EmailDeliveryException('SMTP ' . $stage . ' failed: ' . $e->getMessage());
    }
    $code = (int)substr($response, 0, 3);
    if (!in_array($code, $expected, true)) {
        throw new EmailDeliveryException('SMTP ' . $stage . ' was rejected with response ' . $code . '.');
    }
    return $response;
}

function sendAppEmail(string $to, string $subject, string $body): void
{
    $host = getenv('SMTP_HOST') ?: '';
    $port = filter_var(getenv('SMTP_PORT') ?: '587', FILTER_VALIDATE_INT);
    $username = getenv('SMTP_USERNAME') ?: '';
    $password = preg_replace('/\s+/', '', getenv('SMTP_PASSWORD') ?: '');
    $from = getenv('SMTP_FROM') ?: '';

    if (
        $host === ''
        || !$port
        || $port < 1
        || $port > 65535
        || $username === ''
        || $password === ''
        || !filter_var($from, FILTER_VALIDATE_EMAIL)
        || !filter_var($to, FILTER_VALIDATE_EMAIL)
        || preg_match('/[^a-zA-Z0-9.-]/', $host)
        || preg_match('/[\r\n]/', $host . $username . $password . $from . $to)
    ) {
        throw new EmailDeliveryException('Email sending is not configured. Please contact the site owner.');
    }

    $timeout = 15;
    $socket = @stream_socket_client(
        'tcp://' . $host . ':' . $port,
        $errorCode,
        $errorMessage,
        $timeout,
        STREAM_CLIENT_CONNECT
    );
    if (!$socket) {
        error_log('ADBMS email connection failed with code ' . (int)$errorCode . '.');
        throw new EmailDeliveryException('SMTP connection failed with error code ' . (int)$errorCode . '.');
    }

    stream_set_timeout($socket, $timeout);
    try {
        $greeting = smtpReadResponse($socket);
        if ((int)substr($greeting, 0, 3) !== 220) {
            throw new EmailDeliveryException('The SMTP greeting was rejected with response ' . (int)substr($greeting, 0, 3) . '.');
        }
        smtpCommand($socket, 'EHLO localhost', [250], 'EHLO');
        smtpCommand($socket, 'STARTTLS', [220], 'STARTTLS');
        if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            throw new EmailDeliveryException('A secure email connection could not be established.');
        }
        smtpCommand($socket, 'EHLO localhost', [250], 'EHLO after TLS');
        smtpCommand($socket, 'AUTH LOGIN', [334], 'AUTH LOGIN');
        smtpCommand($socket, base64_encode($username), [334], 'SMTP username');
        smtpCommand($socket, base64_encode($password), [235], 'SMTP password');
        smtpCommand($socket, 'MAIL FROM:<' . $from . '>', [250], 'MAIL FROM');
        smtpCommand($socket, 'RCPT TO:<' . $to . '>', [250, 251], 'RCPT TO');
        smtpCommand($socket, 'DATA', [354], 'DATA');

        $safeSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
        $messageDomain = substr(strrchr($from, '@'), 1);
        $encodedBody = rtrim(chunk_split(base64_encode($body), 76, "\r\n"));
        $message = implode("\r\n", [
            'From: ' . $from,
            'To: ' . $to,
            'Subject: ' . $safeSubject,
            'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $messageDomain . '>',
            'Date: ' . date(DATE_RFC2822),
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            $encodedBody,
        ]);
        $message = preg_replace('/(?m)^\./', '..', $message);
        smtpWrite($socket, $message . "\r\n.\r\n");
        $deliveryResponse = smtpReadResponse($socket);
        if ((int)substr($deliveryResponse, 0, 3) !== 250) {
            throw new EmailDeliveryException('SMTP message delivery was rejected with response ' . (int)substr($deliveryResponse, 0, 3) . '.');
        }
        try {
            smtpCommand($socket, 'QUIT', [221], 'QUIT');
        } catch (EmailDeliveryException $e) {
            // The SMTP server has already accepted the message; a failed
            // session close must not make the app report that delivery failed.
            error_log('ADBMS email was accepted, but SMTP QUIT failed: ' . $e->getMessage());
        }
    } catch (EmailDeliveryException $e) {
        error_log('ADBMS email delivery failed: ' . $e->getMessage());
        throw $e;
    } catch (Throwable $e) {
        error_log('ADBMS email delivery failed due to a transport error.');
        throw new EmailDeliveryException('The email could not be sent. Please try again later.');
    } finally {
        fclose($socket);
    }
}

function appUrl(string $action, string $token): string
{
    $baseUrl = rtrim(getenv('APP_BASE_URL') ?: '', '/');
    $parts = $baseUrl !== '' ? parse_url($baseUrl) : false;
    if (
        !$parts
        || !in_array($parts['scheme'] ?? '', ['http', 'https'], true)
        || empty($parts['host'])
        || isset($parts['user'])
        || isset($parts['pass'])
        || isset($parts['query'])
        || isset($parts['fragment'])
    ) {
        throw new EmailDeliveryException('The application URL is not configured. Please contact the site owner.');
    }

    return $baseUrl . '/index.php#' . rawurlencode($action) . '=' . rawurlencode($token);
}
