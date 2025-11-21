import express from "express"
import multer from "multer"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import cors from "cors"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 7860
const DATA_FILE = path.join(__dirname, "public", "upload.json")
const UPLOADS_DIR = path.join(__dirname, "public", "uploads")

// Ensure uploads directory exists
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error)

// Middleware
app.use(cors()) // Enable CORS for all origins
app.use(express.json()) // For parsing application/json
app.use(express.urlencoded({ extended: true })) // For parsing application/x-www-form-urlencoded
app.use(express.static(path.join(__dirname, "public"))) // Serve static files from 'public' directory

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR)
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`)
  },
})

const upload = multer({ storage: storage })

// Helper function to read data from upload.json
async function readPackages() {
  try {
    const data = await fs.readFile(DATA_FILE, "utf8")
    return JSON.parse(data)
  } catch (error) {
    if (error.code === "ENOENT") {
      // File does not exist, return empty array
      return []
    }
    console.error("Error reading packages file:", error)
    return []
  }
}

// Helper function to write data to upload.json
async function writePackages(packages) {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(packages, null, 2), "utf8")
  } catch (error) {
    console.error("Error writing packages file:", error)
  }
}

// API Endpoints

// GET all packages
app.get("/api/packages", async (req, res) => {
  const packages = await readPackages()
  res.json(packages)
})

// POST a new package
app.post("/api/packages", upload.single("packageImage"), async (req, res) => {
  const packages = await readPackages()
  const newPackage = req.body

  // Generate tracking number if not provided
  if (!newPackage.trackingNumber) {
    newPackage.trackingNumber = Math.random().toString().substr(2, 10)
  }

  // Check if tracking number already exists
  if (packages.some((p) => p.trackingNumber === newPackage.trackingNumber)) {
    return res.status(409).json({ message: "Tracking number already exists." })
  }

  // Set image path
  if (req.file) {
    newPackage.packageImage = `/uploads/${req.file.filename}`
  } else if (newPackage.packageImage === "null" || newPackage.packageImage === "") {
    // If no file uploaded and image field is empty/null, use default
    newPackage.packageImage = "/placeholder.svg?height=200&width=200"
  }
  // If packageImage is already a URL (from imageUrlInput), keep it as is.

  // Add default events if none provided
  if (!newPackage.events || newPackage.events.length === 0) {
    newPackage.events = [
      {
        description: "Package created",
        timestamp: new Date().toISOString(),
        location: "Origin facility",
        completed: true,
      },
    ]
  } else {
    // Ensure events are parsed correctly if sent as stringified JSON
    try {
      newPackage.events = JSON.parse(newPackage.events)
    } catch (e) {
      // Already an array or not valid JSON, keep as is
    }
  }

  newPackage.createdAt = new Date().toISOString()
  newPackage.isGlobal = false // Mark as user-added package

  packages.push(newPackage)
  await writePackages(packages)
  res.status(201).json(newPackage)
})

// PUT (update) an existing package
app.put("/api/packages/:trackingNumber", upload.single("packageImage"), async (req, res) => {
  const trackingNumber = req.params.trackingNumber
  const packages = await readPackages()
  const packageIndex = packages.findIndex((p) => p.trackingNumber === trackingNumber)

  if (packageIndex === -1) {
    return res.status(404).json({ message: "Package not found." })
  }

  const updatedPackage = { ...packages[packageIndex], ...req.body }

  // Handle image update
  if (req.file) {
    // Delete old image if it exists and is not a placeholder
    const oldImagePath = packages[packageIndex].packageImage
    if (oldImagePath && oldImagePath.startsWith("/uploads/")) {
      const oldFileName = path.basename(oldImagePath)
      const fullOldPath = path.join(UPLOADS_DIR, oldFileName)
      try {
        await fs.unlink(fullOldPath)
      } catch (error) {
        console.warn(`Could not delete old image file: ${fullOldPath}`, error.message)
      }
    }
    updatedPackage.packageImage = `/uploads/${req.file.filename}`
  } else if (updatedPackage.packageImage === "null" || updatedPackage.packageImage === "") {
    // If no new file and image field is empty/null, remove image
    const oldImagePath = packages[packageIndex].packageImage
    if (oldImagePath && oldImagePath.startsWith("/uploads/")) {
      const oldFileName = path.basename(oldImagePath)
      const fullOldPath = path.join(UPLOADS_DIR, oldFileName)
      try {
        await fs.unlink(fullOldPath)
      } catch (error) {
        console.warn(`Could not delete old image file: ${fullOldPath}`, error.message)
      }
    }
    updatedPackage.packageImage = "/placeholder.svg?height=200&width=200"
  }
  // If packageImage is already a URL (from imageUrlInput), keep it as is.

  // Ensure events are parsed correctly if sent as stringified JSON
  try {
    updatedPackage.events = JSON.parse(updatedPackage.events)
  } catch (e) {
    // Already an array or not valid JSON, keep as is
  }

  packages[packageIndex] = updatedPackage
  await writePackages(packages)
  res.json(updatedPackage)
})

// DELETE a package
app.delete("/api/packages/:trackingNumber", async (req, res) => {
  const trackingNumber = req.params.trackingNumber
  let packages = await readPackages()
  const initialLength = packages.length

  const packageToDelete = packages.find((p) => p.trackingNumber === trackingNumber)

  if (!packageToDelete) {
    return res.status(404).json({ message: "Package not found." })
  }

  // Prevent deletion of global packages
  if (packageToDelete.isGlobal) {
    return res.status(403).json({ message: "Cannot delete global packages." })
  }

  // Delete associated image file if it exists and is an uploaded file
  if (packageToDelete.packageImage && packageToDelete.packageImage.startsWith("/uploads/")) {
    const fileName = path.basename(packageToDelete.packageImage)
    const filePath = path.join(UPLOADS_DIR, fileName)
    try {
      await fs.unlink(filePath)
      console.log(`Deleted image file: ${filePath}`)
    } catch (error) {
      console.warn(`Could not delete image file: ${filePath}`, error.message)
    }
  }

  packages = packages.filter((p) => p.trackingNumber !== trackingNumber)

  if (packages.length < initialLength) {
    await writePackages(packages)
    res.status(200).json({ message: "Package deleted successfully." })
  } else {
    res.status(500).json({ message: "Failed to delete package." })
  }
})

// Serve the frontend HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Admin password: admin123`)
  console.log(`Sample tracking numbers: 1234567890, 9876543210, 5555666677, 7777888899`)
})
