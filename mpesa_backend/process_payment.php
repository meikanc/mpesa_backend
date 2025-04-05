<?php
session_start();
include 'config.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid request method.']);
    exit;
}

// Verify database connection
if (!$pdo) {
    echo json_encode(['success' => false, 'message' => 'Database connection failed']);
    exit;
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data) {
    echo json_encode(['success' => false, 'message' => 'Invalid JSON input.']);
    exit;
}

// Enhanced validation
$requiredFields = ['method', 'amount', 'cart'];
foreach ($requiredFields as $field) {
    if (!isset($data[$field])) {
        echo json_encode(['success' => false, 'message' => "Missing required field: $field"]);
        exit;
    }
}

$paymentMethod = strtolower(trim($data['method']));
$amount = floatval($data['amount']);
$cartItems = $data['cart'];
$phone = isset($data['phone']) ? preg_replace('/[^0-9]/', '', $data['phone']) : null;

// Validate phone number format for mobile payments
if (in_array($paymentMethod, ['mpesa', 'airtel'])) {
    if (empty($phone)) {
        echo json_encode(['success' => false, 'message' => 'Phone number is required for mobile payments.']);
        exit;
    }
    
    // Convert to 254 format if in 07... format
    if (strlen($phone) === 10 && strpos($phone, '0') === 0) {
        $phone = '254' . substr($phone, 1);
    }
    
    if (!preg_match('/^254[17][0-9]{8}$/', $phone)) {
        echo json_encode(['success' => false, 'message' => 'Invalid Kenyan phone number format.']);
        exit;
    }
}

try {
    $pdo->beginTransaction();

    // 1. Create the order
    $stmt = $pdo->prepare("INSERT INTO orders (total_price, status, created_at) VALUES (?, ?, NOW())");
    $orderStatus = ($paymentMethod === 'cash') ? 'pending' : 'processing';
    if (!$stmt->execute([$amount, $orderStatus])) {
        throw new Exception("Failed to create order");
    }
    $orderId = $pdo->lastInsertId();

    // 2. Add order items
    $stmtItem = $pdo->prepare("INSERT INTO order_items (order_id, product_id, quantity, subtotal) VALUES (?, ?, ?, ?)");
    
    foreach ($cartItems as $item) {
        if (!isset($item['id'], $item['quantity'], $item['price'])) {
            throw new Exception("Invalid cart item structure");
        }
        
        $subtotal = floatval($item['price']) * intval($item['quantity']);
        if (!$stmtItem->execute([$orderId, intval($item['id']), intval($item['quantity']), $subtotal])) {
            throw new Exception("Failed to add order item");
        }
    }

    // 3. Create payment record
    $stmtPayment = $pdo->prepare("
        INSERT INTO payments 
        (order_id, amount, payment_method, phone_number, status, transaction_id, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, NOW())
    ");
    
    $transactionRef = 'ORD' . $orderId . time();
    $paymentStatus = ($paymentMethod === 'cash') ? 'pending' : 'initiated';
    
    if (!$stmtPayment->execute([$orderId, $amount, $paymentMethod, $phone, $paymentStatus, $transactionRef])) {
        throw new Exception("Failed to create payment record");
    }

    // 4. For MPESA, create transaction record
    if ($paymentMethod === 'mpesa') {
        $checkoutRequestId = 'MPESA_' . time() . '_' . $orderId;
        
        $stmtMpesa = $pdo->prepare("
            INSERT INTO mpesa_transactions 
            (order_id, phone, amount, status, checkout_request_id, created_at)
            VALUES (?, ?, ?, 'initiated', ?, NOW())
        ");
        
        if (!$stmtMpesa->execute([$orderId, $phone, $amount, $checkoutRequestId])) {
            throw new Exception("Failed to create MPESA transaction");
        }

        // Update order with MPESA reference
        $stmtUpdate = $pdo->prepare("UPDATE orders SET checkout_request_id = ? WHERE id = ?");
        if (!$stmtUpdate->execute([$checkoutRequestId, $orderId])) {
            throw new Exception("Failed to update order with checkout request ID");
        }
    }

    $pdo->commit();

    echo json_encode([
        'success' => true,
        'order_id' => $orderId,
        'transaction_id' => $transactionRef,
        'checkout_request_id' => ($paymentMethod === 'mpesa') ? $checkoutRequestId : null
    ]);

} catch (PDOException $e) {
    $pdo->rollBack();
    error_log("PDO Error: " . $e->getMessage());
    error_log("Error Info: " . print_r($pdo->errorInfo(), true));
    echo json_encode([
        'success' => false,
        'message' => 'Database error',
        'error_code' => $e->getCode(),
        'error_info' => $pdo->errorInfo() // Remove in production
    ]);
} catch (Exception $e) {
    $pdo->rollBack();
    error_log("Error: " . $e->getMessage());
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}
?>